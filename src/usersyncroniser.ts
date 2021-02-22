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

import { User, GuildMember } from "better-discord.js";
import { DiscordBot } from "./bot";
import { Util } from "./util";
import { DiscordBridgeConfig } from "./config";
import { Log } from "./log";
import { IMatrixEvent } from "./matrixtypes";
import { DbUserStore, RemoteUser } from "./db/userstore";
import { Appservice, Intent } from "matrix-bot-sdk";

const log = new Log("UserSync");

const DEFAULT_USER_STATE = {
    avatarId: "",
    avatarUrl: null,
    createUser: false,
    displayName: null,
    id: null,
    mxUserId: null,
    removeAvatar: false,
};

const DEFAULT_GUILD_STATE = {
    displayName: "",
    id: null,
    mxUserId: null,
    roles: [],
};

export interface IUserState {
    avatarId: string;
    avatarUrl: string | null;
    createUser: boolean;
    displayName: string | null;
    id: string;
    mxUserId: string;
    removeAvatar: boolean; // If the avatar has been removed from the user.
}

export interface IGuildMemberRole {
    name: string;
    color: number;
    position: number;
}

export interface IGuildMemberState {
    bot: boolean;
    displayColor?: number;
    displayName: string;
    id: string;
    mxUserId: string;
    roles: IGuildMemberRole[];
    username: string;
}

/**
 * Class that syncronises Discord users with their bridge ghost counterparts.
 * Also handles member events that may occur when using guild nicknames.
 */
export class UserSyncroniser {

    public static readonly ERR_NO_ERROR = "";
    public static readonly ERR_USER_NOT_FOUND = "user_not_found";
    public static readonly ERR_CHANNEL_MEMBER_NOT_FOUND = "channel_or_member_not_found";
    public static readonly ERR_NEWER_EVENT = "newer_state_event_arrived";

    // roomId+userId => ev
    public userStateHold: Map<string, IMatrixEvent>;
    constructor(
        private bridge: Appservice,
        private config: DiscordBridgeConfig,
        private discord: DiscordBot,
        private userStore: DbUserStore) {
        this.userStateHold = new Map<string, IMatrixEvent>();
    }

    /**
     * Should be called when the discord user is updated.
     * @param {module:discord.js.User} Old user object. If not used, new user object.
     * @param {module:discord.js.User} New user object
     * @returns {Promise<void>}
     * @constructor
     */
    public async OnUpdateUser(discordUser: User, isWebhook: boolean = false) {
        const userState = await this.GetUserUpdateState(discordUser, isWebhook);
        try {
            await this.ApplyStateToProfile(userState);
        } catch (e) {
            log.error("Failed to update user's profile", e);
        }
    }

    public async ApplyStateToProfile(userState: IUserState) {
        const intent = this.bridge.getIntentForUserId(userState.mxUserId);
        let userUpdated = false;
        let remoteUser: RemoteUser;
        if (userState.createUser) {
            /* NOTE: Setting the displayname/avatar will register the user if they don't exist */
            log.info(`Creating new user ${userState.mxUserId}`);
            remoteUser = new RemoteUser(userState.id);
            await this.userStore.linkUsers(
                userState.mxUserId.substring("@".length),
                userState.id,
            );

        } else {
            const rUser = await this.userStore.getRemoteUser(userState.id);
            remoteUser = rUser ? rUser : new RemoteUser(userState.id);
        }
        await intent.ensureRegistered();

        if (userState.displayName !== null) {
            log.verbose(`Updating displayname for ${userState.mxUserId} to "${userState.displayName}"`);
            await intent.underlyingClient.setDisplayName(userState.displayName);
            remoteUser.displayname = userState.displayName;
            userUpdated = true;
        }

        if (userState.avatarUrl !== null) {
            log.verbose(`Updating avatar_url for ${userState.mxUserId} to "${userState.avatarUrl}"`);
            const data = await Util.DownloadFile(userState.avatarUrl);
            const avatarMxc = await intent.underlyingClient.uploadContent(
                data.buffer,
                data.mimeType,
                userState.avatarId,
            );
            await intent.underlyingClient.setAvatarUrl(avatarMxc);
            remoteUser.avatarurl = userState.avatarUrl;
            remoteUser.avatarurlMxc = avatarMxc;
            userUpdated = true;
        }

        if (userState.removeAvatar) {
            log.verbose(`Clearing avatar_url for ${userState.mxUserId} to "${userState.avatarUrl}"`);
            await intent.underlyingClient.setAvatarUrl("");
            remoteUser.avatarurl = null;
            remoteUser.avatarurlMxc = null;
            userUpdated = true;
        }

        if (userUpdated) {
            await this.userStore.setRemoteUser(remoteUser);
            await this.UpdateStateForGuilds(remoteUser);
        }
    }

    public async JoinRoom(member: GuildMember | User, roomId: string, isWebhook: boolean = false) {
        let state: IGuildMemberState;
        if (member instanceof User) {
            state = await this.GetUserStateForDiscordUser(member, isWebhook);
        } else {
            state = await this.GetUserStateForGuildMember(member);
        }
        log.info(`Joining ${state.id} in ${roomId}`);
        const guildId = member instanceof User ? undefined : member.guild.id;
        try {
            await this.ApplyStateToRoom(state, roomId, guildId);
        } catch (e) {
            if (e.errcode !== "M_FORBIDDEN") {
                log.error(`Failed to join ${state.id} to ${roomId}`, e);
                throw e;
            } else {
                log.info(`User not in room ${roomId}, inviting`);
                try {
                    await this.bridge.botIntent.underlyingClient.inviteUser(state.mxUserId, roomId);
                    await this.ApplyStateToRoom(state, roomId, guildId);
                } catch (e) {
                    log.error(`Failed to join ${state.id} to ${roomId}`, e);
                    throw e;
                }
            }
        }
    }

    public async SetRoomState(member: GuildMember, roomId: string) {
        const state = await this.GetUserStateForGuildMember(member);
        log.info(`Setting room state for ${state.id} in ${roomId}`);
        await this.ApplyStateToRoom(state, roomId, member.guild.id);
    }

    public async ApplyStateToRoom(memberState: IGuildMemberState, roomId: string, guildId?: string) {
        log.info(`Applying new room state for ${memberState.mxUserId} to ${roomId}`);
        if (!memberState.displayName) {
            // Nothing to do. Quitting
            return;
        }
        const remoteUser = await this.userStore.getRemoteUser(memberState.id);
        let avatar: string|undefined;
        if (remoteUser) {
            avatar = remoteUser.avatarurlMxc || undefined;
        } else {
            log.warn("Remote user wasn't found, using blank avatar");
        }
        const intent = this.bridge.getIntentForUserId(memberState.mxUserId);
        /* The intent class tries to be smart and deny a state update for <PL50 users.
           Obviously a user can change their own state so we use the client instead. */
        await intent.underlyingClient.sendStateEvent(roomId, "m.room.member", memberState.mxUserId, {
            "avatar_url": avatar,
            "displayname": memberState.displayName,
            "membership": "join",
            "uk.half-shot.discord.member": {
                bot: memberState.bot,
                displayColor: memberState.displayColor,
                id: memberState.id,
                roles: memberState.roles,
                username: memberState.username,
            },
        });

        if (remoteUser) {
            if (guildId) {
                remoteUser.guildNicks.set(guildId, memberState.displayName);
            }
            await this.userStore.setRemoteUser(remoteUser);
        }
    }

    public async GetUserUpdateState(discordUser: User, isWebhook: boolean = false): Promise<IUserState> {
        log.verbose(`State update requested for ${discordUser.id}`);
        let mxidExtra = "";
        if (isWebhook) {
            // for webhooks we append the username to the mxid, as webhooks with the same
            // id can have multiple different usernames set. This way we don't spam
            // userstate changes

            mxidExtra = `_${Util.ParseMxid(`@${discordUser.username}`).localpart}`;
        }
        const userState: IUserState = Object.assign({}, DEFAULT_USER_STATE, {
            id: discordUser.id + mxidExtra,
            mxUserId: `@_discord_${discordUser.id}${mxidExtra}:${this.config.bridge.domain}`,
        });
        const displayName = Util.ApplyPatternString(this.config.ghosts.usernamePattern, {
            id: discordUser.id,
            tag: discordUser.discriminator,
            username: discordUser.username,
        });
        // Determine if the user exists.
        const remoteId = discordUser.id + mxidExtra;
        const remoteUser = await this.userStore.getRemoteUser(remoteId);
        if (remoteUser === null) {
            log.verbose(`Could not find user in remote user store.`);
            userState.createUser = true;
            userState.displayName = displayName;
            if (discordUser.avatar) {
                userState.avatarUrl = discordUser.avatarURL();
                userState.avatarId = discordUser.avatar;
            }
            return userState;
        }

        const oldDisplayName = remoteUser.displayname;
        if (oldDisplayName !== displayName) {
            log.verbose(`User ${discordUser.id} displayname should be updated`);
            userState.displayName = displayName;
        }

        const oldAvatarUrl = remoteUser.avatarurl;
        if (oldAvatarUrl !== discordUser.avatarURL()) {
            log.verbose(`User ${discordUser.id} avatarurl should be updated`);
            if (discordUser.avatar) {
                userState.avatarUrl = discordUser.avatarURL();
                userState.avatarId = discordUser.avatar;
            } else {
                userState.removeAvatar = true;
            }
        }

        return userState;
    }

    public async GetUserStateForGuildMember(
        newMember: GuildMember,
    ): Promise<IGuildMemberState> {
        const name = Util.ApplyPatternString(this.config.ghosts.nickPattern, {
            id: newMember.user.id,
            nick: newMember.displayName,
            tag: newMember.user.discriminator,
            username: newMember.user.username,
        });
        const guildState: IGuildMemberState = Object.assign({}, DEFAULT_GUILD_STATE, {
            bot: newMember.user.bot,
            displayColor: newMember.displayColor,
            displayName: name,
            id: newMember.id,
            mxUserId: `@_discord_${newMember.id}:${this.config.bridge.domain}`,
            roles: newMember.roles.cache.map((role) => { return {
                color: role.color,
                name: role.name,
                position: role.position,
            }; }),
            username: newMember.user.tag,
        });
        return guildState;
    }

    public async GetUserStateForDiscordUser(
        user: User,
        isWebhook: boolean = false,
    ): Promise<IGuildMemberState> {
        let mxidExtra = "";
        if (isWebhook) {
            // for webhooks we append the username to the mxid, as webhooks with the same
            // id can have multiple different usernames set. This way we don't spam
            // userstate changes
            mxidExtra = "_" + Util.ParseMxid(`@${user.username}`, false).localpart;
        }
        const guildState: IGuildMemberState = Object.assign({}, DEFAULT_GUILD_STATE, {
            bot: user.bot,
            displayName: user.username,
            id: user.id + mxidExtra,
            mxUserId: `@_discord_${user.id}${mxidExtra}:${this.config.bridge.domain}`,
            roles: [],
            username: user.tag,
        });
        return guildState;
    }

    public async OnAddGuildMember(member: GuildMember) {
        log.info(`Joining ${member.id} to all rooms for guild ${member.guild.id}`);
        await this.OnUpdateGuildMember(member, true, false);
    }

    public async OnRemoveGuildMember(member: GuildMember) {
        /* NOTE: This can be because of a kick, ban or the user just leaving. Discord doesn't tell us. */
        log.info(`Leaving ${member.id} to all rooms for guild ${member.guild.id}`);
        const rooms = await this.discord.GetRoomIdsFromGuild(member.guild, undefined, false);
        const intent = this.discord.GetIntentFromDiscordMember(member);
        return Promise.all(
            rooms.map(
                async (roomId) => this.leave(intent, roomId),
            ),
        );
    }

    public async OnUpdateGuildMember(member: GuildMember, doJoin: boolean = false, useCache: boolean = true) {
        log.info(`Got update for ${member.id} (${member.user.username}).`);
        const state = await this.GetUserStateForGuildMember(member);
        let wantRooms: string[] = [];
        try {
            wantRooms = await this.discord.GetRoomIdsFromGuild(member.guild, member, useCache);
        } catch (err) { } // no want rooms
        let allRooms: string[] = [];
        try {
            allRooms = await this.discord.GetRoomIdsFromGuild(member.guild, undefined, useCache);
        } catch (err) { } // no all rooms

        const leaveRooms: string[] = [];
        await Util.AsyncForEach(allRooms, async (r) => {
            if (wantRooms.includes(r)) {
                return;
            }
            leaveRooms.push(r);
        });

        await Promise.all(
            wantRooms.map(
                async (roomId) => {
                    try {
                        if (doJoin) {
                            await this.JoinRoom(member, roomId);
                        } else {
                            await this.ApplyStateToRoom(state, roomId, member.guild.id);
                        }
                    } catch (err) {
                        log.error(`Failed to update ${member.id} (${member.user.username}) in ${roomId}`, err);
                    }
                },
            ),
        );
        const userId = state.mxUserId;
        const intent = this.bridge.getIntentForUserId(userId);
        await Promise.all(
            leaveRooms.map(
                async (roomId) => {
                    try {
                        await this.leave(intent, roomId);
                    } catch (e) { } // not in room
                },
            ),
        );
    }

    public async UpdateStateForGuilds(remoteUser: RemoteUser) {
        const id = remoteUser.id;
        log.info(`Got update for ${id}.`);

        await Util.AsyncForEach(this.discord.GetGuilds(), async (guild) => {
            if (guild.members.cache.has(id)) {
                log.info(`Updating user ${id} in guild ${guild.id}.`);
                const member = guild.members.resolve(id);
                try {
                    const state = await this.GetUserStateForGuildMember(member!);
                    const rooms = await this.discord.GetRoomIdsFromGuild(guild, member!);
                    await Promise.all(
                        rooms.map(
                            async (roomId) => this.ApplyStateToRoom(state, roomId, guild.id),
                        ),
                    );
                } catch (err) {
                    log.warn(`Failed to update user ${id} in guild ${guild.id}`, err);
                }
            }
        });
    }

    private async leave(intent: Intent, roomId: string) {
        await intent.underlyingClient.leaveRoom(roomId);
    }
}
