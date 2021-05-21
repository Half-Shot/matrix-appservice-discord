/*
Copyright 2018, 2019 matrix-appservice-discord

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import * as Discord from "better-discord.js";
import { DiscordBot } from "./bot";
import { Util } from "./util";
import { DiscordBridgeConfig, DiscordBridgeConfigChannelDeleteOptions } from "./config";
import { Log } from "./log";
import { DbRoomStore, IRoomStoreEntry } from "./db/roomstore";
import { Appservice } from "matrix-bot-sdk";

const log = new Log("ChannelSync");

const POWER_LEVEL_MESSAGE_TALK = 50;

const DEFAULT_CHANNEL_STATE = {
    iconMxcUrl: null,
    id: null,
    mxChannels: [],
};

const DEFAULT_SINGLECHANNEL_STATE = {
    iconId: null,
    iconUrl: null,
    mxid: null,
    name: null,
    removeIcon: false,
    topic: null,
};

export interface ISingleChannelState {
    mxid: string;
    name: string | null;
    topic: string | null;
    iconUrl: string | null;
    iconId: string | null;
    removeIcon: boolean;
}

export interface IChannelState {
    id: string;
    mxChannels: ISingleChannelState[];
    iconMxcUrl: string | null;
}

export class ChannelSyncroniser {
    constructor(
        private bridge: Appservice,
        private config: DiscordBridgeConfig,
        private bot: DiscordBot,
        private roomStore: DbRoomStore,
    ) {

    }

    public async OnUpdate(channel: Discord.Channel) {
        if (channel.type !== "text") {
            return; // Not supported for now
        }
        const channelState = await this.GetChannelUpdateState(channel as Discord.TextChannel);
        try {
            await this.ApplyStateToChannel(channelState);
        } catch (e) {
            log.error("Failed to update channels", e);
        }
    }

    public async OnGuildUpdate(guild: Discord.Guild, force = false) {
        log.verbose(`Got guild update for guild ${guild.id}`);
        const channelStates: IChannelState[] = [];
        for (const [_, channel] of guild.channels.cache) {
            if (channel.type !== "text") {
                continue; // not supported for now
            }
            try {
                const channelState = await this.GetChannelUpdateState(channel as Discord.TextChannel, force);
                channelStates.push(channelState);
            } catch (e) {
                log.error("Failed to get channel state", e);
            }
        }

        let iconMxcUrl: string | null = null;
        for (const channelState of channelStates) {
            channelState.iconMxcUrl = channelState.iconMxcUrl || iconMxcUrl;
            try {
                await this.ApplyStateToChannel(channelState);
            } catch (e) {
                log.error("Failed to update channels", e);
            }
            iconMxcUrl = channelState.iconMxcUrl;
        }
    }

    public async OnUnbridge(channel: Discord.Channel, roomId: string) {
        try {
            const entry = (await this.roomStore.getEntriesByMatrixId(roomId))[0];
            const opts = new DiscordBridgeConfigChannelDeleteOptions();
            opts.namePrefix = null;
            opts.topicPrefix = null;
            opts.ghostsLeave = true;
            await this.handleChannelDeletionForRoom(channel as Discord.TextChannel, roomId, entry);
            log.info(`Channel ${channel.id} has been unbridged.`);
        } catch (e) {
            log.error(`Failed to unbridge channel from room: ${e}`);
        }
    }

    public async OnDelete(channel: Discord.Channel) {
        if (channel.type !== "text") {
            log.info(`Channel ${channel.id} was deleted but isn't a text channel, so ignoring.`);
            return;
        }
        log.info(`Channel ${channel.id} has been deleted.`);
        let roomids;
        let entries: IRoomStoreEntry[];
        try {
            roomids = await this.GetRoomIdsFromChannel(channel);
            entries = await this.roomStore.getEntriesByMatrixIds(roomids);
        } catch (e) {
            log.warn(`Couldn't find roomids for deleted channel ${channel.id}`);
            return;
        }
        for (const roomid of roomids) {
            try {
                await this.handleChannelDeletionForRoom(channel as Discord.TextChannel, roomid, entries[roomid][0]);
            } catch (e) {
                log.error(`Failed to delete channel from room: ${e}`);
            }
        }
    }

    public async OnGuildDelete(guild: Discord.Guild) {
        for (const [_, channel] of guild.channels.cache) {
            try {
                await this.OnDelete(channel);
            } catch (e) {
                log.error(`Failed to delete guild channel`);
            }
        }
    }

    public async GetRoomIdsFromChannel(channel: Discord.Channel): Promise<string[]> {
        const rooms = await this.roomStore.getEntriesByRemoteRoomData({
            discord_channel: channel.id,
        });
        if (rooms.length === 0) {
            log.verbose(`Couldn't find room(s) for channel ${channel.id}.`);
            return Promise.reject("Room(s) not found.");
        }
        return rooms.map((room) => room.matrix!.getId() as string);
    }

    public async GetAliasFromChannel(channel: Discord.Channel): Promise<string | null> {
        let rooms: string[] = [];
        try {
            rooms = await this.GetRoomIdsFromChannel(channel);
        } catch (err) { } // do nothing, our rooms array will just be empty
        let fallbackAlias = "";
        for (const room of rooms) {
            try {
                const al = (await this.bridge.botIntent.underlyingClient.getRoomStateEvent(
                    room,
                    "m.room.canonical_alias",
                    "")
                ).alias;
                if (al) {
                    if (this.bridge.isNamespacedAlias(al)) {
                        fallbackAlias = al;
                    } else {
                        return al; // we are done, we found an alias
                    }
                }
            } catch (err) { } // do nothing, as if we error we just roll over to the next entry
        }
        if (fallbackAlias) {
            return fallbackAlias;
        }
        const guildChannel = channel as Discord.TextChannel;
        if (!guildChannel.guild) {
            return null; // we didn't pass a guild, so we have no way of bridging this room, thus no alias
        }
        // at last, no known canonical aliases and we are a guild....so we know an alias!
        return this.bridge.getAliasForSuffix(`${guildChannel.guild.id}_${channel.id}`);
    }

    public async GetChannelUpdateState(channel: Discord.TextChannel, forceUpdate = false): Promise<IChannelState> {
        log.verbose(`State update request for ${channel.id}`);
        const channelState: IChannelState = Object.assign({}, DEFAULT_CHANNEL_STATE, {
            id: channel.id,
            mxChannels: [],
        });

        const remoteRooms = await this.roomStore.getEntriesByRemoteRoomData({discord_channel: channel.id});
        if (remoteRooms.length === 0) {
            log.verbose(`Could not find any channels in room store.`);
            return channelState;
        }

        const name: string = Util.ApplyPatternString(this.config.channel.namePattern, {
            guild: channel.guild.name,
            name: "#" + channel.name,
        });
        const topic = channel.topic;
        const icon = channel.guild.icon;
        let iconUrl: string | null = null;
        if (icon) {
            // if discord prefixes their icon hashes with "a_" it means that they are animated
            const animatedIcon = icon.startsWith("a_");
            iconUrl = `https://cdn.discordapp.com/icons/${channel.guild.id}/${icon}.${animatedIcon ? "gif" : "png"}`;
        }
        remoteRooms.forEach((remoteRoom) => {
            const mxid = remoteRoom.matrix!.getId();
            const singleChannelState: ISingleChannelState = Object.assign({}, DEFAULT_SINGLECHANNEL_STATE, {
                mxid,
            });

            const oldName = remoteRoom.remote!.get("discord_name");
            if (remoteRoom.remote!.get("update_name") && (forceUpdate || oldName !== name)) {
                log.verbose(`Channel ${mxid} name should be updated`);
                singleChannelState.name = name;
            }

            const oldTopic = remoteRoom.remote!.get("discord_topic");
            if (remoteRoom.remote!.get("update_topic") && (forceUpdate || oldTopic !== topic)) {
                log.verbose(`Channel ${mxid} topic should be updated`);
                singleChannelState.topic = topic;
            }

            const oldIconUrl = remoteRoom.remote!.get("discord_iconurl");
            // no force on icon update as we don't want to duplicate ALL the icons
            if (remoteRoom.remote!.get("update_icon") && oldIconUrl !== iconUrl) {
                log.verbose(`Channel ${mxid} icon should be updated`);
                if (iconUrl !== null) {
                    singleChannelState.iconUrl = iconUrl;
                    singleChannelState.iconId = icon;
                } else {
                    singleChannelState.removeIcon = oldIconUrl !== null;
                }
            }
            channelState.mxChannels.push(singleChannelState);
        });
        return channelState;
    }

    public async EnsureState(channel: Discord.TextChannel) {
        const state = await this.GetChannelUpdateState(channel, true);
        log.info(`Ensuring ${state.id} to be correct`);
        await this.ApplyStateToChannel(state);
    }

    private async ApplyStateToChannel(channelsState: IChannelState) {
        const intent = this.bridge.botIntent;
        for (const channelState of channelsState.mxChannels) {
            let roomUpdated = false;
            const remoteRoom = (await this.roomStore.getEntriesByMatrixId(channelState.mxid))[0];
            if (!remoteRoom.remote) {
                log.warn("Remote room not set for this room");
                return;
            }
            if (channelState.name !== null) {
                log.verbose(`Updating channelname for ${channelState.mxid} to "${channelState.name}"`);
                await intent.underlyingClient.sendStateEvent(
                    channelState.mxid,
                    "m.room.name",
                    "",
                    { name: channelState.name },
                );
                remoteRoom.remote.set("discord_name", channelState.name);
                roomUpdated = true;
            }

            if (channelState.topic !== null) {
                log.verbose(`Updating channeltopic for ${channelState.mxid} to "${channelState.topic}"`);
                await intent.underlyingClient.sendStateEvent(
                    channelState.mxid,
                    "m.room.topic",
                    "",
                    { topic: channelState.topic },
                );
                remoteRoom.remote.set("discord_topic", channelState.topic);
                roomUpdated = true;
            }

            if (channelState.iconUrl !== null && channelState.iconId !== null) {
                log.verbose(`Updating icon_url for ${channelState.mxid} to "${channelState.iconUrl}"`);
                if (channelsState.iconMxcUrl === null) {
                    const file = await Util.DownloadFile(channelState.iconUrl);
                    const iconMxc = await this.bridge.botIntent.underlyingClient.uploadContent(
                        file.buffer,
                        file.mimeType,
                        channelState.iconId,
                    );
                    channelsState.iconMxcUrl = iconMxc;
                }
                await intent.underlyingClient.sendStateEvent(
                    channelState.mxid,
                    "m.room.avatar",
                    "",
                    // TODO: "info" object for avatar
                    { url: channelsState.iconMxcUrl },
                );
                remoteRoom.remote.set("discord_iconurl", channelState.iconUrl);
                remoteRoom.remote.set("discord_iconurl_mxc", channelsState.iconMxcUrl);
                roomUpdated = true;
            }

            if (channelState.removeIcon) {
                log.verbose(`Clearing icon_url for ${channelState.mxid}`);
                await intent.underlyingClient.sendStateEvent(
                    channelState.mxid,
                    "m.room.avatar",
                    "",
                    {  },
                );
                remoteRoom.remote.set("discord_iconurl", null);
                remoteRoom.remote.set("discord_iconurl_mxc", null);
                roomUpdated = true;
            }

            if (roomUpdated) {
                await this.roomStore.upsertEntry(remoteRoom);
            }
        }
    }

    private async handleChannelDeletionForRoom(
        channel: Discord.TextChannel,
        roomId: string,
        entry: IRoomStoreEntry,
        overrideOptions?: DiscordBridgeConfigChannelDeleteOptions): Promise<void> {
        log.info(`Deleting ${channel.id} from ${roomId}.`);
        const client = this.bridge.botClient;
        const options = overrideOptions || this.config.channel.deleteOptions;
        const plumbed = entry.remote!.get("plumbed");

        await this.roomStore.upsertEntry(entry);
        if (options.ghostsLeave) {
            for (const member of channel.members.array()) {
                try {
                    await client.leaveRoom(roomId);
                    log.verbose(`${member.id} left ${roomId}.`);
                } catch (e) {
                    log.warn(`Failed to make ${member.id} leave `);
                }
            }
        }
        if (options.namePrefix) {
            try {
                const name = await client.getRoomStateEvent(roomId, "m.room.name", "");
                name.name = options.namePrefix + name.name;
                await client.sendStateEvent(
                    roomId,
                    "m.room.name",
                    "",
                    name,
                );
            } catch (e) {
                log.error(`Failed to set name of room ${roomId} ${e}`);
            }
        }
        if (options.topicPrefix) {
            try {
                const topic = await client.getRoomStateEvent(roomId, "m.room.topic", "");
                topic.topic = options.topicPrefix + topic.topic;
                await client.sendStateEvent(
                    roomId,
                    "m.room.topic",
                    "",
                    topic,
                );
            } catch (e) {
                log.error(`Failed to set topic of room ${roomId} ${e}`);
            }
        }

        if (plumbed !== true) {
            if (options.unsetRoomAlias) {
                try {
                    const alias = `#_${entry.remote!.roomId}:${this.config.bridge.domain}`;
                    const canonicalAlias = await client.getRoomStateEvent(
                        roomId,
                        "m.room.canonical_alias",
                        "",
                    );
                    if (canonicalAlias.alias === alias) {
                        await client.sendStateEvent(roomId, "m.room.canonical_alias", "", {});
                    }
                    await client.deleteRoomAlias(alias);
                } catch (e) {
                    log.error(`Couldn't remove alias of ${roomId} ${e}`);
                }
            }

            if (options.unlistFromDirectory) {
                try {
                    await client.setDirectoryVisibility(roomId, "private");
                } catch (e) {
                    log.error(`Couldn't remove ${roomId} from room directory ${e}`);
                }

            }

            if (options.setInviteOnly) {
                try {
                    await client.sendStateEvent(
                        roomId,
                        "m.room.join_rules",
                        "",
                        {join_role: "invite"},
                    );
                } catch (e) {
                    log.error(`Couldn't set ${roomId} to private ${e}`);
                }
            }

            if (options.disableMessaging) {
                try {
                    const state = await client.getRoomStateEvent(roomId, "m.room.power_levels", "");
                    state.events_default = POWER_LEVEL_MESSAGE_TALK;
                    await client.sendStateEvent(roomId, "m.room.power_levels", "", state);
                } catch (e) {
                    log.error(`Couldn't disable messaging for ${roomId} ${e}`);
                }
            }
        }

        await this.roomStore.removeEntriesByMatrixRoomId(roomId);
    }
}
