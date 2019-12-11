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
import { DiscordBridgeConfig } from "./config";
import { Util, wrapError } from "./util";
import * as path from "path";
import * as mime from "mime";
import { IMatrixEvent, IMatrixEventContent, IMatrixMessage } from "./matrixtypes";
import { MatrixMessageProcessor, IMatrixMessageProcessorParams } from "./matrixmessageprocessor";
import { MatrixCommandHandler } from "./matrixcommandhandler";
import { DbEvent } from "./db/dbdataevent";

import { Log } from "./log";
import { IRoomStoreEntry, RemoteStoreRoom } from "./db/roomstore";
import { Appservice, MatrixClient } from "matrix-bot-sdk";
import { DiscordStore } from "./store";
import { TimedCache } from "./structures/timedcache";

const log = new Log("MatrixEventProcessor");

const MaxFileSize = 8000000;
const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 32;
const DISCORD_AVATAR_WIDTH = 128;
const DISCORD_AVATAR_HEIGHT = 128;
const ROOM_NAME_PARTS = 2;
const AGE_LIMIT = 900000; // 15 * 60 * 1000
const PROFILE_CACHE_LIFETIME = 900000;

export class MatrixEventProcessorOpts {
    constructor(
        readonly config: DiscordBridgeConfig,
        readonly bridge: Appservice,
        readonly discord: DiscordBot,
        readonly store: DiscordStore,
        ) {

    }
}

export interface IMatrixEventProcessorResult {
    messageEmbed: Discord.MessageEmbed;
    replyEmbed?: Discord.MessageEmbed;
    imageEmbed?: Discord.MessageEmbed;
}

export class MatrixEventProcessor {
    private config: DiscordBridgeConfig;
    private bridge: Appservice;
    private discord: DiscordBot;
    private store: DiscordStore;
    private matrixMsgProcessor: MatrixMessageProcessor;
    private mxCommandHandler: MatrixCommandHandler;
    private mxUserProfileCache: TimedCache<string, {displayname: string, avatar_url: string|undefined}>;

    constructor(opts: MatrixEventProcessorOpts, cm?: MatrixCommandHandler) {
        this.config = opts.config;
        this.bridge = opts.bridge;
        this.store = opts.store;
        this.discord = opts.discord;
        this.store = opts.store;
        this.matrixMsgProcessor = new MatrixMessageProcessor(this.discord, this.config);
        this.mxUserProfileCache = new TimedCache(PROFILE_CACHE_LIFETIME);
        if (cm) {
            this.mxCommandHandler = cm;
        } else {
            this.mxCommandHandler = new MatrixCommandHandler(this.discord, this.bridge, this.config);
        }
    }

    /**
     * Callback which is called when the HS notifies the bridge of a new event.
     *
     * @param request Request object containing the event for which this callback is called.
     * @param context The current context of the bridge.
     * @throws {Unstable.EventNotHandledError} When the event can finally not be handled.
     */
    public async OnEvent(event: IMatrixEvent, rooms: IRoomStoreEntry[]): Promise<void> {
        const remoteRoom = rooms[0];
        if (event.unsigned.age > AGE_LIMIT) {
            log.info(`Skipping event due to age ${event.unsigned.age} > ${AGE_LIMIT}`);
            // throw new Unstable.EventTooOldError(
            //     `Skipping event due to age ${event.unsigned.age} > ${AGE_LIMIT}`,
            // );
            return;
        }
        if (
            event.type === "m.room.member" &&
            event.content!.membership === "invite" &&
            event.state_key === this.bridge.botUserId
        ) {
            await this.mxCommandHandler.HandleInvite(event);
            return;
        } else if (event.type === "m.room.member" && this.bridge.isNamespacedUser(event.state_key)) {
            if (["leave", "ban"].includes(event.content!.membership!) && event.sender !== event.state_key) {
                // Kick/Ban handling
                let prevMembership = "";
                if (event.content!.membership === "leave" && event.replaces_state) {
                    const intent = this.bridge.botIntent;
                    prevMembership = (await intent.underlyingClient.getEvent(
                        event.room_id,
                        event.replaces_state,
                    )).content.membership;
                }
                await this.discord.HandleMatrixKickBan(
                    event.room_id,
                    event.state_key,
                    event.sender,
                    event.content!.membership as "leave"|"ban",
                    prevMembership,
                    event.content!.reason,
                );
            }
            return;
        } else if (this.bridge.isNamespacedUser(event.sender)) {
            // Ignore echo
            return;
        } else if (["m.room.member", "m.room.name", "m.room.topic"].includes(event.type)) {
            await this.ProcessStateEvent(event);
            return;
        } else if (event.type === "m.room.encryption" && remoteRoom) {
            await this.HandleEncryptionWarning(event.room_id);
            return;
        } else if (this.config.bridge.userBlacklist.includes(event.sender)) {
            log.verbose(`Ignoring blacklisted user ${event.sender}`);
            return;
        } else if (event.type === "m.room.redaction" && remoteRoom) {
            await this.discord.ProcessMatrixRedact(event);
            return;
        } else if (event.type === "m.room.message" || event.type === "m.sticker") {
            log.verbose(`Got ${event.type} event`);
            if (isBotCommand(event)) {
                await this.mxCommandHandler.Process(event, remoteRoom);
            } else if (remoteRoom) {
                try {
                    await this.ProcessMsgEvent(event, remoteRoom.remote!);
                } catch (err) {
                    log.warn("There was an error sending a matrix event", err);
                }
            }
            return;
        }
        // throw new Unstable.EventUnknownError(`${event.event_id} not processed by bridge`);
        log.verbose(`${event.event_id} not processed by bridge`);
    }

    public async HandleEncryptionWarning(roomId: string): Promise<void> {
        log.info(`User has turned on encryption in ${roomId}, so leaving.`);
        /* N.B 'status' is not specced but https://github.com/matrix-org/matrix-doc/pull/828
         has been open for over a year with no resolution. */
        const sendPromise = this.bridge.botIntent.sendEvent(roomId, {
            body: "You have turned on encryption in this room, so the service will not bridge any new messages.",
            msgtype: "m.notice",
            status: "critical",
        });
        const channel = await this.discord.GetChannelFromRoomId(roomId);
        await (channel as Discord.TextChannel).send(
          "Someone on Matrix has turned on encryption in this room, so the service will not bridge any new messages",
        );
        await sendPromise;
        await this.bridge.botIntent.underlyingClient.leaveRoom(roomId);
        await this.store.roomStore.removeEntriesByMatrixRoomId(roomId);
    }

    /**
     * Processes a matrix event by sending it to Discord and marking the event as read.
     *
     * @param event The matrix m.room.message event to process.
     * @param context Context of the bridge.
     * @throws {Unstable.ForeignNetworkError}
     */
    public async ProcessMsgEvent(event: IMatrixEvent, room: RemoteStoreRoom): Promise<void> {
        const guildId = room.data.discord_guild!;
        const channelId = room.data.discord_channel!;
        const mxClient = this.bridge.botClient;
        log.verbose(`Looking up ${guildId}_${channelId}`);
        const roomLookup = await this.discord.LookupRoom(guildId, channelId, event.sender);
        const chan = roomLookup.channel;

        let editEventId = "";
        if (event.content && event.content["m.relates_to"] && event.content["m.relates_to"].rel_type === "m.replace") {
            const editMatrixId = `${event.content["m.relates_to"].event_id};${event.room_id}`;
            const storeEvent = await this.store.Get(DbEvent, {matrix_id: editMatrixId});
            if (storeEvent && storeEvent.Result && storeEvent.Next()) {
                editEventId = storeEvent.DiscordId;
            }
        }

        const embedSet = await this.EventToEmbed(event, chan);
        const opts: Discord.MessageOptions = {};
        const file = await this.HandleAttachment(event, mxClient, roomLookup.canSendEmbeds);
        if (typeof(file) === "string") {
            embedSet.messageEmbed.description += " " + file;
        } else if ((file as Discord.FileOptions).name && (file as Discord.FileOptions).attachment) {
            opts.files = [file as Discord.FileOptions];
        } else {
            embedSet.imageEmbed = file as Discord.MessageEmbed;
        }

    // Throws an `Unstable.ForeignNetworkError` when sending the message fails.
        if (editEventId) {
            await this.discord.edit(embedSet, opts, roomLookup, event, editEventId);
        } else {
            await this.discord.send(embedSet, opts, roomLookup, event);
        }
        // Don't await this.
        this.sendReadReceipt(event).catch((ex) => {
            log.verbose("Failed to send read reciept for ", event.event_id, ex);
        });
    }

    public async ProcessStateEvent(event: IMatrixEvent) {
        log.verbose(`Got state event from ${event.room_id} ${event.type}`);

        const SUPPORTED_EVENTS = ["m.room.member", "m.room.name", "m.room.topic"];
        if (!SUPPORTED_EVENTS.includes(event.type)) {
            log.verbose(`${event.event_id} ${event.type} is not displayable.`);
            return;
        }

        if (event.sender === this.bridge.botUserId) {
            log.verbose(`${event.event_id} ${event.type} is by our bot user, ignoring.`);
            return;
        }

        let msg = `\`${event.sender}\` `;

        const allowJoinLeave = !this.config.bridge.disableJoinLeaveNotifications;
        const allowInvite = !this.config.bridge.disableInviteNotifications;

        if (event.type === "m.room.name") {
            msg += `set the name to \`${event.content!.name}\``;
        } else if (event.type === "m.room.topic") {
            msg += `set the topic to \`${event.content!.topic}\``;
        } else if (event.type === "m.room.member") {
            const membership = event.content!.membership;
            const client = this.bridge.botIntent.underlyingClient;
            const isNewJoin = event.unsigned.replaces_state === undefined ? true : (
                await client.getEvent(event.room_id, event.unsigned.replaces_state)).content.membership !== "join";
            if (membership === "join") {
                this.mxUserProfileCache.delete(`${event.room_id}:${event.sender}`);
                this.mxUserProfileCache.delete(event.sender);
                if (event.content!.displayname) {
                    this.mxUserProfileCache.set(`${event.room_id}:${event.sender}`, {
                        avatar_url: event.content!.avatar_url,
                        displayname: event.content!.displayname!,
                    });
                }
                // We don't know if the user also updated their profile, but to be safe..
                this.mxUserProfileCache.delete(event.sender);
            }
            if (membership === "join" && isNewJoin && allowJoinLeave) {
                msg += "joined the room";
            } else if (membership === "invite" && allowInvite) {
                msg += `invited \`${event.state_key}\` to the room`;
            } else if (membership === "leave" && event.state_key !== event.sender) {
                msg += `kicked \`${event.state_key}\` from the room`;
            } else if (membership === "leave" && allowJoinLeave) {
                msg += "left the room";
            } else if (membership === "ban") {
                msg += `banned \`${event.state_key}\` from the room`;
            } else {
                // Ignore anything else
                return;
            }
        }

        msg += " on Matrix.";
        if (!this.config.bridge.userBlacklist.includes(event.sender)) {
            const channel = await this.discord.GetChannelFromRoomId(event.room_id) as Discord.TextChannel;
            await this.discord.sendAsBot(msg, channel, event);
        } else {
            log.info(`Not posting state event message for blacklisted user ${event.sender}. Would have said: "${msg}"`);
        }
        await this.sendReadReceipt(event);
    }

    public async EventToEmbed(
        event: IMatrixEvent, channel: Discord.TextChannel, getReply: boolean = true,
    ): Promise<IMatrixEventProcessorResult> {
        const mxClient = this.bridge.botIntent.underlyingClient;
        const profile = await this.GetUserProfileForRoom(event.room_id, event.sender);
        const params = {
            mxClient,
            roomId: event.room_id,
            userId: event.sender,
        } as IMatrixMessageProcessorParams;
        if (profile) {
            params.displayname = profile.displayname;
        }

        let body: string = "";
        if (event.type !== "m.sticker") {
            const content = event.content!["m.new_content"] ? event.content!["m.new_content"] : event.content;
            body = await this.matrixMsgProcessor.FormatMessage(content as IMatrixMessage, channel.guild, params);
        }

        const messageEmbed = new Discord.MessageEmbed();
        messageEmbed.setDescription(body);
        await this.SetEmbedAuthor(messageEmbed, event.sender, profile);
        const replyEmbed = getReply ? (await this.GetEmbedForReply(event, channel)) : undefined;
        if (replyEmbed && replyEmbed.fields) {
            for (let i = 0; i < replyEmbed.fields.length; i++) {
                const f = replyEmbed.fields[i];
                if (f.name === "ping") {
                    messageEmbed.description += `\n(${f.value})`;
                    replyEmbed.fields.splice(i, 1);
                    break;
                }
            }
        }
        return {
            messageEmbed,
            replyEmbed,
        };
    }

    public async HandleAttachment(
        event: IMatrixEvent,
        mxClient: MatrixClient,
        sendEmbeds: boolean = false,
    ): Promise<string|Discord.FileOptions|Discord.MessageEmbed> {
        if (!this.HasAttachment(event)) {
            return "";
        }

        if (!event.content) {
            event.content = {};
        }

        if (!event.content.info) {
            // Fractal sends images without an info, which is technically allowed
            // but super unhelpful:  https://gitlab.gnome.org/World/fractal/issues/206
            event.content.info = {mimetype: "", size: 0};
        }

        if (!event.content.url) {
            log.info("Event was an attachment type but was missing a content.url");
            return "";
        }

        let size = event.content.info.size || 0;
        const name = this.GetFilenameForMediaEvent(event.content);
        const url = this.bridge.botClient.mxcToHttp(event.content.url);
        if (size < MaxFileSize) {
            const attachment = (await Util.DownloadFile(url)).buffer;
            size = attachment.byteLength;
            if (size < MaxFileSize) {
                return {
                    attachment,
                    name,
                } as Discord.FileOptions;
            }
        }
        if (sendEmbeds && event.content.info.mimetype.split("/")[0] === "image") {
            return new Discord.MessageEmbed()
                .setImage(url);
        }
        return `[${name}](${url})`;
    }

    public async GetEmbedForReply(
        event: IMatrixEvent,
        channel: Discord.TextChannel,
    ): Promise<Discord.MessageEmbed|undefined> {
        if (!event.content) {
            event.content = {};
        }

        const relatesTo = event.content["m.relates_to"];
        let eventId = "";
        if (relatesTo && relatesTo["m.in_reply_to"]) {
            eventId = relatesTo["m.in_reply_to"].event_id;
        } else {
            return;
        }

        const intent = this.bridge.botIntent;
        // Try to get the event.
        try {
            const sourceEvent = (await intent.underlyingClient.getEvent(event.room_id, eventId)) as IMatrixEvent;
            if (!sourceEvent || !sourceEvent.content || !sourceEvent.content.body) {
                throw Error("No content could be found");
            }
            const replyEmbed = (await this.EventToEmbed(sourceEvent, channel, true)).messageEmbed;

            // if we reply to a discord member, ping them!
            if (this.bridge.isNamespacedUser(sourceEvent.sender)) {
                const uid = this.bridge.getSuffixForUserId(sourceEvent.sender);
                replyEmbed.addField("ping", `<@${uid}>`);
            }

            replyEmbed.setTimestamp(new Date(sourceEvent.origin_server_ts!));

            if (this.HasAttachment(sourceEvent)) {
                const url = this.bridge.botClient.mxcToHttp(sourceEvent.content!.url!);
                if (["m.image", "m.sticker"].includes(sourceEvent.content!.msgtype as string)
                    || sourceEvent.type === "m.sticker") {
                    // we have an image reply
                    replyEmbed.setImage(url);
                } else {
                    const name = this.GetFilenameForMediaEvent(sourceEvent.content!);
                    replyEmbed.description = `[${name}](${url})`;
                }
            }
            return replyEmbed;
        } catch (ex) {
            log.warn("Failed to handle reply, showing a unknown embed:", ex);
        }
        // For some reason we failed to get the event, so using fallback.
        const embed = new Discord.MessageEmbed();
        embed.setDescription("Reply with unknown content");
        embed.setAuthor("Unknown");
        return embed;
    }

    private async GetUserProfileForRoom(roomId: string, userId: string) {
        const mxClient = this.bridge.botIntent.underlyingClient;
        let profile: {displayname: string, avatar_url: string|undefined} | undefined;
        try {
            // First try to pull out the room-specific profile from the cache.
            profile = this.mxUserProfileCache.get(`${roomId}:${userId}`);
            if (profile) {
                return profile;
            }
            log.verbose(`Profile ${userId}:${roomId} not cached`);

            // Failing that, try fetching the state.
            profile = await mxClient.getRoomStateEvent(roomId, "m.room.member", userId);
            if (profile) {
                this.mxUserProfileCache.set(`${roomId}:${userId}`, profile);
                return profile;
            }

            // Try fetching the users profile from the cache
            profile = this.mxUserProfileCache.get(userId);
            if (profile) {
                return profile;
            }

            // Failing that, try fetching the profile.
            log.verbose(`Profile ${userId} not cached`);
            profile = await mxClient.getUserProfile(userId);
            if (profile) {
                this.mxUserProfileCache.set(userId, profile);
                return profile;
            }
            log.warn(`User ${userId} has no member state and no profile. That's odd.`);
        } catch (err) {
            log.warn(`Trying to fetch member state or profile for ${userId} failed`, err);
        }
        return undefined;
    }

    private async sendReadReceipt(event: IMatrixEvent) {
        if (!this.config.bridge.disableReadReceipts) {
            try {
                await this.bridge.botIntent.underlyingClient.sendReadReceipt(event.room_id, event.event_id);
            } catch (err) {
                log.error(`Failed to send read receipt for ${event}. `, err);
            }
        }
    }

    private HasAttachment(event: IMatrixEvent): boolean {
        if (!event.content) {
            event.content = {};
        }

        const hasAttachment = [
            "m.image",
            "m.audio",
            "m.video",
            "m.file",
            "m.sticker",
        ].includes(event.content.msgtype as string) || [
            "m.sticker",
        ].includes(event.type);
        return hasAttachment;
    }

    private async SetEmbedAuthor(embed: Discord.MessageEmbed, sender: string, profile?: {
        displayname: string,
        avatar_url: string|undefined }) {
        let displayName = sender;
        let avatarUrl;

        // Are they a discord user.
        if (this.bridge.isNamespacedUser(sender)) {
            const localpart = Util.ParseMxid(sender).localpart;
            const userOrMember = await this.discord.GetDiscordUserOrMember(localpart.substring("_discord".length));
            if (userOrMember instanceof Discord.User) {
                embed.setAuthor(
                    userOrMember.username,
                    userOrMember.avatarURL() || undefined,
                );
                return;
            } else if (userOrMember instanceof Discord.GuildMember) {
                embed.setAuthor(
                    userOrMember.displayName,
                    userOrMember.user.avatarURL() || undefined,
                );
                return;
            }
            // Let it fall through.
        }

        if (profile) {
            if (profile.displayname &&
                profile.displayname.length >= MIN_NAME_LENGTH &&
                profile.displayname.length <= MAX_NAME_LENGTH) {
                displayName = profile.displayname;
            }

            if (profile.avatar_url) {
                avatarUrl = this.bridge.botClient.mxcToHttpThumbnail(
                    profile.avatar_url,
                    DISCORD_AVATAR_WIDTH,
                    DISCORD_AVATAR_HEIGHT,
                    "scale",
                );
            }
        }
        embed.setAuthor(
            displayName.substr(0, MAX_NAME_LENGTH),
            avatarUrl,
            `https://matrix.to/#/${sender}`,
        );
    }

    private GetFilenameForMediaEvent(content: IMatrixEventContent): string {
        let ext = "";
        try {
            ext = "." + mime.getExtension(content.info.mimetype);
        } catch (err) { } // pass, we don't have an extension
        if (content.body) {
            if (path.extname(content.body) !== "") {
                return content.body;
            }
            return path.basename(content.body) + ext;
        }
        return "matrix-media" + ext;
    }
}

/**
 * Returns true if the given event is a bot command.
 */
function isBotCommand(event: IMatrixEvent): boolean {
    return !!(
        event.type === "m.room.message" &&
        event.content!.body &&
        event.content!.body!.startsWith("!discord")
    );
}
