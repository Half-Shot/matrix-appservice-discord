/*
Copyright 2017 - 2019 matrix-appservice-discord

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

import { DiscordBridgeConfig } from "./config";
import { DiscordClientFactory } from "./clientfactory";
import { DiscordStore } from "./store";
import { DbEmoji } from "./db/dbdataemoji";
import { DbEvent } from "./db/dbdataevent";
import { DiscordMessageProcessor } from "./discordmessageprocessor";
import { IDiscordMessageParserResult } from "matrix-discord-parser";
import { MatrixEventProcessor, MatrixEventProcessorOpts, IMatrixEventProcessorResult } from "./matrixeventprocessor";
import { PresenceHandler } from "./presencehandler";
import { Provisioner } from "./provisioner";
import { UserSyncroniser } from "./usersyncroniser";
import { ChannelSyncroniser } from "./channelsyncroniser";
import { MatrixRoomHandler } from "./matrixroomhandler";
import { Log } from "./log";
import * as Discord from "better-discord.js";
import * as mime from "mime";
import { IMatrixEvent, IMatrixMediaInfo, IMatrixMessage } from "./matrixtypes";
import { Appservice, Intent } from "matrix-bot-sdk";
import { DiscordCommandHandler } from "./discordcommandhandler";
import { MetricPeg } from "./metrics";
import { Lock } from "./structures/lock";
import { Util } from "./util";

const log = new Log("DiscordBot");

const MIN_PRESENCE_UPDATE_DELAY = 250;
const TYPING_TIMEOUT_MS = 30 * 1000;
const CACHE_LIFETIME = 90000;

// TODO: This is bad. We should be serving the icon from the own homeserver.
const MATRIX_ICON_URL = "https://matrix.org/_matrix/media/r0/download/matrix.org/mlxoESwIsTbJrfXyAAogrNxA";
class ChannelLookupResult {
    public channel: Discord.TextChannel;
    public botUser: boolean;
    public canSendEmbeds: boolean;
}

interface IThirdPartyLookupField {
    channel_id: string;
    channel_name: string;
    guild_id: string;
}

export interface IThirdPartyLookup {
    alias: string;
    fields: IThirdPartyLookupField;
    protocol: string;
}

export class DiscordBot {
    private clientFactory: DiscordClientFactory;
    private bot: Discord.Client;
    private presenceInterval: number;
    private sentMessages: string[];
    private lastEventIds: { [channelId: string]: string };
    private discordMsgProcessor: DiscordMessageProcessor;
    private mxEventProcessor: MatrixEventProcessor;
    private presenceHandler: PresenceHandler;
    private userSync!: UserSyncroniser;
    private channelSync: ChannelSyncroniser;
    private roomHandler: MatrixRoomHandler;
    private provisioner: Provisioner;
    private discordCommandHandler: DiscordCommandHandler;
    /* Caches */
    private roomIdsForGuildCache: Map<string, {roomIds: string[], ts: number}> = new Map();

    /* Handles messages queued up to be sent to matrix from discord. */
    private discordMessageQueue: { [channelId: string]: Promise<void> };
    private channelLock: Lock<string>;
    private typingTimers: Record<string, NodeJS.Timeout> = {}; // DiscordUser+channel -> Timeout
    constructor(
        private config: DiscordBridgeConfig,
        private bridge: Appservice,
        private store: DiscordStore,
    ) {

        // create handlers
        this.clientFactory = new DiscordClientFactory(store, config.auth);
        this.discordMsgProcessor = new DiscordMessageProcessor(config.bridge.domain, this);
        this.presenceHandler = new PresenceHandler(this);
        this.roomHandler = new MatrixRoomHandler(this, config, bridge, store.roomStore);
        this.channelSync = new ChannelSyncroniser(bridge, config, this, store.roomStore);
        this.provisioner = new Provisioner(store.roomStore, this.channelSync);
        this.mxEventProcessor = new MatrixEventProcessor(
            new MatrixEventProcessorOpts(config, bridge, this, store),
        );
        this.discordCommandHandler = new DiscordCommandHandler(bridge, this);
        // init vars
        this.sentMessages = [];
        this.discordMessageQueue = {};
        this.channelLock = new Lock(this.config.limits.discordSendDelay);
        this.lastEventIds = {};
    }

    get ClientFactory(): DiscordClientFactory {
        return this.clientFactory;
    }

    get UserSyncroniser(): UserSyncroniser {
        return this.userSync;
    }

    get ChannelSyncroniser(): ChannelSyncroniser {
        return this.channelSync;
    }

    get BotUserId(): string {
        return this.bridge.botUserId;
    }

    get RoomHandler(): MatrixRoomHandler {
        return this.roomHandler;
    }

    get MxEventProcessor(): MatrixEventProcessor {
        return this.mxEventProcessor;
    }

    get Provisioner(): Provisioner {
        return this.provisioner;
    }

    public GetIntentFromDiscordMember(member: Discord.GuildMember | Discord.PartialUser | Discord.User,
                                      webhookID: string|null = null): Intent {
        if (webhookID) {
            // webhookID and user IDs are the same, they are unique, so no need to prefix _webhook_
            const name = member instanceof Discord.GuildMember ? member.user.username : member.username;
            if (!name) {
                log.error("Couldn't get intent for Discord member, name was null:", member);
                throw Error("Couldn't get intent for Discord member, name was null");
            }
            // TODO: We need to sanitize name
            return this.bridge.getIntentForSuffix(`${webhookID}_${Util.EscapeStringForUserId(name)}`);
        }
        return this.bridge.getIntentForSuffix(member.id);
    }

    public async init(): Promise<void> {
        await this.clientFactory.init();
        // This immediately pokes UserStore, so it must be created after the bridge has started.
        this.userSync = new UserSyncroniser(this.bridge, this.config, this, this.store.userStore);
    }

    public async run(): Promise<void> {
        const client = await this.clientFactory.getClient();
        if (!this.config.bridge.disableTypingNotifications) {
            client.on("typingStart", async (channel, user) => {
                try {
                    await this.OnTyping(channel, user, true);
                } catch (err) { log.warning("Exception thrown while handling \"typingStart\" event", err); }
            });
        }
        if (!this.config.bridge.disablePresence) {
            client.on("presenceUpdate", (_, newPresence) => {
                try {
                    this.presenceHandler.EnqueueUser(newPresence);
                } catch (err) { log.warning("Exception thrown while handling \"presenceUpdate\" event", err); }
            });
        }
        client.on("channelUpdate", async (_, newChannel) => {
            try {
                await this.channelSync.OnUpdate(newChannel);
            } catch (err) { log.error("Exception thrown while handling \"channelUpdate\" event", err); }
        });
        client.on("channelDelete", async (channel) => {
            try {
                await this.channelSync.OnDelete(channel);
            } catch (err) { log.error("Exception thrown while handling \"channelDelete\" event", err); }
        });
        client.on("guildUpdate", async (_, newGuild) => {
            try {
                await this.channelSync.OnGuildUpdate(newGuild);
            } catch (err) { log.error("Exception thrown while handling \"guildUpdate\" event", err); }
        });
        client.on("guildDelete", async (guild) => {
            try {
                await this.channelSync.OnGuildDelete(guild);
            } catch (err) { log.error("Exception thrown while handling \"guildDelete\" event", err); }
        });

        // Due to messages often arriving before we get a response from the send call,
        // messages get delayed from discord. We use Util.DelayedPromise to handle this.

        client.on("messageDelete", async (msg: Discord.Message) => {
            try {
                await this.channelLock.wait(msg.channel.id);
                this.clientFactory.bindMetricsToChannel(msg.channel as Discord.TextChannel);
                this.discordMessageQueue[msg.channel.id] = (async () => {
                    await (this.discordMessageQueue[msg.channel.id] || Promise.resolve());
                    try {
                        await this.DeleteDiscordMessage(msg);
                    } catch (err) {
                        log.error("Caught while handing 'messageDelete'", err);
                    }
                })();
            } catch (err) {
                log.error("Exception thrown while handling \"messageDelete\" event", err);
            }
        });
        client.on("messageDeleteBulk", async (msgs: Discord.Collection<Discord.Snowflake, Discord.Message>) => {
            try {
                await Util.DelayedPromise(this.config.limits.discordSendDelay);
                const promiseArr: (() => Promise<void>)[] = [];
                msgs.forEach((msg) => {
                    promiseArr.push(async () => {
                        try {
                            await this.channelLock.wait(msg.channel.id);
                            this.clientFactory.bindMetricsToChannel(msg.channel as Discord.TextChannel);
                            await this.DeleteDiscordMessage(msg);
                        } catch (err) {
                            log.error("Caught while handling 'messageDeleteBulk'", err);
                        }
                    });
                });
                await Promise.all(promiseArr);
            } catch (err) {
                log.error("Exception thrown while handling \"messageDeleteBulk\" event", err);
            }
        });
        client.on("messageUpdate", async (oldMessage: Discord.Message, newMessage: Discord.Message) => {
            try {
                await this.channelLock.wait(newMessage.channel.id);
                this.clientFactory.bindMetricsToChannel(newMessage.channel as Discord.TextChannel);
                this.discordMessageQueue[newMessage.channel.id] = (async () => {
                    await (this.discordMessageQueue[newMessage.channel.id] || Promise.resolve());
                    try {
                        await this.OnMessageUpdate(oldMessage, newMessage);
                    } catch (err) {
                        log.error("Caught while handing 'messageUpdate'", err);
                    }
                })();
            } catch (err) {
                log.error("Exception thrown while handling \"messageUpdate\" event", err);
            }
        });
        client.on("message", async (msg: Discord.Message) => {
            try {
                log.verbose(`Got incoming msg i:${msg.id} c:${msg.channel.id} g:${msg.guild?.id}`);
                MetricPeg.get.registerRequest(msg.id);
                await this.channelLock.wait(msg.channel.id);
                this.clientFactory.bindMetricsToChannel(msg.channel as Discord.TextChannel);
                this.discordMessageQueue[msg.channel.id] = (async () => {
                    await (this.discordMessageQueue[msg.channel.id] || Promise.resolve());
                    try {
                        await this.OnMessage(msg);
                    } catch (err) {
                        MetricPeg.get.requestOutcome(msg.id, true, "fail");
                        log.error("Caught while handing 'message'", err);
                    }
                })();
            } catch (err) {
                log.error("Exception thrown while handling \"message\" event", err);
            }
        });
        const jsLog = new Log("discord.js");

        client.on("userUpdate", async (_, user) => {
            try {
                if (!(user instanceof Discord.User)) {
                    log.warn(`Ignoring update for ${user.username}. User was partial.`);
                    return;
                }
                await this.userSync.OnUpdateUser(user);
            } catch (err) { log.error("Exception thrown while handling \"userUpdate\" event", err); }
        });
        client.on("guildMemberAdd", async (member) => {
            try {
                if (!(member instanceof Discord.GuildMember)) {
                    log.warn(`Ignoring update for ${member.guild.id} ${member.id}. User was partial.`);
                    return;
                }
                await this.userSync.OnAddGuildMember(member);
            } catch (err) { log.error("Exception thrown while handling \"guildMemberAdd\" event", err); }
        });
        client.on("guildMemberRemove", async (member) =>  {
            try {
                if (!(member instanceof Discord.GuildMember)) {
                    log.warn(`Ignoring update for ${member.guild.id} ${member.id}. User was partial.`);
                    return;
                }
                await this.userSync.OnRemoveGuildMember(member);
            } catch (err) { log.error("Exception thrown while handling \"guildMemberRemove\" event", err); }
        });
        client.on("guildMemberUpdate", async (_, member) => {
            try {
                if (!(member instanceof Discord.GuildMember)) {
                    log.warn(`Ignoring update for ${member.guild.id} ${member.id}. User was partial.`);
                    return;
                }
                await this.userSync.OnUpdateGuildMember(member);
            } catch (err) { log.error("Exception thrown while handling \"guildMemberUpdate\" event", err); }
        });
        client.on("debug", (msg) => { jsLog.verbose(msg); });
        client.on("error", (msg) => { jsLog.error(msg); });
        client.on("warn", (msg) => { jsLog.warn(msg); });
        log.info("Discord bot client logged in.");
        this.bot = client;

        if (!this.config.bridge.disablePresence) {
            if (!this.config.bridge.presenceInterval) {
                this.config.bridge.presenceInterval = MIN_PRESENCE_UPDATE_DELAY;
            }
            this.bot.guilds.cache.forEach((guild) => {
                guild.members.cache.forEach((member) => {
                    if (member.id !== this.GetBotId()) {
                        this.presenceHandler.EnqueueUser(member.user.presence);
                    }
                });
            });
            await this.presenceHandler.Start(
                Math.max(this.config.bridge.presenceInterval, MIN_PRESENCE_UPDATE_DELAY),
            );
        }
    }

    public GetBotId(): string {
        // TODO: What do we do here?
        return this.bot.user!.id;
    }

    public GetGuilds(): Discord.Guild[] {
        return this.bot.guilds.cache.array();
    }

    public ThirdpartySearchForChannels(guildId: string, channelName: string): IThirdPartyLookup[] {
        if (channelName.startsWith("#")) {
            channelName = channelName.substring(1);
        }
        if (this.bot.guilds.cache.has(guildId) ) {
            const guild = this.bot.guilds.cache.get(guildId);
            return guild!.channels.cache.filter((channel) => {
                return channel.name.toLowerCase() === channelName.toLowerCase(); // Implement searching in the future.
            }).map((channel) => {
                return {
                    alias: `#_discord_${guild!.id}_${channel.id}:${this.config.bridge.domain}`,
                    fields: {
                        channel_id: channel.id,
                        channel_name: channel.name,
                        guild_id: guild!.id,
                    },
                    protocol: "discord",
                } as IThirdPartyLookup;
            });
        } else {
            log.info("Tried to do a third party lookup for a channel, but the guild did not exist");
            return [];
        }
    }

    public async LookupRoom(server: string, room: string, sender?: string): Promise<ChannelLookupResult> {
        const hasSender = sender !== null && sender !== undefined;
        try {
            const client = await this.clientFactory.getClient(sender);
            const guild = client.guilds.resolve(server);
            if (!guild) {
                throw new Error(`Guild "${server}" not found`);
            }
            const channel = guild.channels.resolve(room);
            if (channel && channel.type === "text") {
                if (hasSender) {
                    const permissions = guild.me && channel.permissionsFor(guild.me);
                    if (!permissions || !permissions.has("VIEW_CHANNEL") || !permissions.has("SEND_MESSAGES")) {
                        throw new Error(`Can't send into channel`);
                    }
                }

                this.ClientFactory.bindMetricsToChannel(channel as Discord.TextChannel);
                const lookupResult = new ChannelLookupResult();
                lookupResult.channel = channel as Discord.TextChannel;
                lookupResult.botUser = this.bot.user?.id === client.user?.id;
                lookupResult.canSendEmbeds = client.user?.bot || false; // only bots can send embeds
                return lookupResult;
            }
            throw new Error(`Channel "${room}" not found`);
        } catch (err) {
            log.verbose("LookupRoom => ", err);
            if (hasSender) {
                log.verbose(`Couldn't find guild/channel under user account. Falling back.`);
                return await this.LookupRoom(server, room);
            }
            throw err;
        }
    }

    public async sendAsBot(msg: string, channel: Discord.TextChannel, event: IMatrixEvent): Promise<void> {
        if (!msg) {
            return;
        }
        this.channelLock.set(channel.id);
        const res = await channel.send(msg);
        await this.StoreMessagesSent(res, channel, event);
        this.channelLock.release(channel.id);
    }

    /**
     * Edits an event on Discord.
     * @throws {Unstable.ForeignNetworkError}
     */
    public async edit(
        embedSet: IMatrixEventProcessorResult,
        opts: Discord.MessageOptions,
        roomLookup: ChannelLookupResult,
        event: IMatrixEvent,
        editEventId: string,
    ): Promise<void> {
        const chan = roomLookup.channel;
        const botUser = roomLookup.botUser;
        const embed = embedSet.messageEmbed;
        const oldMsg = await chan.messages.fetch(editEventId);
        if (!oldMsg) {
            // old message not found, just sending this normally
            await this.send(embedSet, opts, roomLookup, event);
            return;
        }
        if (!botUser) {
            try {
                if (!roomLookup.canSendEmbeds) {
                    await oldMsg.edit(this.prepareEmbedSetUserAccount(embedSet), opts);
                } else {
                    opts.embed = this.prepareEmbedSetBotAccount(embedSet);
                    await oldMsg.edit(embed.description, opts);
                }
                return;
            } catch (err) {
                log.warning("Failed to edit discord message, falling back to delete and resend...", err);
            }
        }
        try {
            if (editEventId === this.lastEventIds[chan.id]) {
                log.info("Immediate edit, deleting and re-sending");
                this.channelLock.set(chan.id);
                // we need to delete the event off of the store
                // else the delete bridges over back to matrix
                const dbEvent = await this.store.Get(DbEvent, { discord_id: editEventId });
                log.verbose("Event to delete", dbEvent);
                if (dbEvent && dbEvent.Next()) {
                    await this.store.Delete(dbEvent);
                }
                await oldMsg.delete();
                this.channelLock.release(chan.id);
                const msg = await this.send(embedSet, opts, roomLookup, event, true);
                // we re-insert the old matrix event with the new discord id
                // to allow consecutive edits, as matrix edits are typically
                // done on the original event
                const dummyEvent = {
                    event_id: event.content!["m.relates_to"].event_id,
                    room_id: event.room_id,
                } as IMatrixEvent;
                this.StoreMessagesSent(msg, chan, dummyEvent).catch(() => {
                    log.warn("Failed to store edit sent message for ", event.event_id);
                });
                return;
            }
            const link = `https://discord.com/channels/${chan.guild.id}/${chan.id}/${editEventId}`;
            embedSet.messageEmbed.description = `[Edit](${link}): ${embedSet.messageEmbed.description}`;
            await this.send(embedSet, opts, roomLookup, event);
        } catch (err) {
            // throw wrapError(err, Unstable.ForeignNetworkError, "Couldn't edit message");
            log.warn(`Failed to edit message ${event.event_id}`);
            log.verbose(err);
        }
    }

    /**
     * Sends an event to Discord.
     * @throws {Unstable.ForeignNetworkError}
     */
    public async send(
        embedSet: IMatrixEventProcessorResult,
        opts: Discord.MessageOptions,
        roomLookup: ChannelLookupResult,
        event: IMatrixEvent,
        awaitStore: boolean = false,
    ): Promise<Discord.Message | null | (Discord.Message | null)[]> {
        const chan = roomLookup.channel;
        const botUser = roomLookup.botUser;
        const embed = embedSet.messageEmbed;

        let msg: Discord.Message | null | (Discord.Message | null)[] = null;
        let hook: Discord.Webhook | undefined;
        if (botUser) {
            const webhooks = await chan.fetchWebhooks();
            hook = webhooks.filter((h) => h.name === "_matrix").first();
            // Create a new webhook if none already exists
            try {
                if (!hook) {
                    hook = await chan.createWebhook(
                        "_matrix",
                        {
                            avatar: MATRIX_ICON_URL,
                            reason: "Matrix Bridge: Allow rich user messages",
                        });
                }
            } catch (err) {
               // throw wrapError(err, Unstable.ForeignNetworkError, "Unable to create \"_matrix\" webhook");
               log.warn("Unable to create _matrix webook:", err);
            }
        }
        try {
            this.channelLock.set(chan.id);
            if (!roomLookup.canSendEmbeds) {
                // NOTE: Don't send replies to discord if we are a puppet user.
                msg = await chan.send(this.prepareEmbedSetUserAccount(embedSet), opts);
            } else if (!botUser) {
                opts.embed = this.prepareEmbedSetBotAccount(embedSet);
                msg = await chan.send(embed.description, opts);
            } else if (hook) {
                MetricPeg.get.remoteCall("hook.send");
                const embeds = this.prepareEmbedSetWebhook(embedSet);
                msg = await hook.send(embed.description, {
                    avatarURL: embed!.author!.iconURL,
                    embeds,
                    files: opts.files,
                    username: embed!.author!.name,
                });
            } else {
                opts.embed = this.prepareEmbedSetBot(embedSet);
                msg = await chan.send("", opts);
            }
            // Don't block on this.
            const storePromise = this.StoreMessagesSent(msg, chan, event).then(() => {
                this.channelLock.release(chan.id);
            }).catch(() => {
                log.warn("Failed to store sent message for ", event.event_id);
            });
            if (awaitStore) {
                await storePromise;
            }
        } catch (err) {
            // throw wrapError(err, Unstable.ForeignNetworkError, "Couldn't send message");
            log.warn(`Failed to send message ${event.event_id}`);
            log.verbose(err);
        }
        return msg;
    }

    public async ProcessMatrixRedact(event: IMatrixEvent) {
        if (this.config.bridge.disableDeletionForwarding) {
            return;
        }
        if (this.config.bridge.IsUserBlacklisted(event.sender)) {
            log.verbose(`Redact request for ${event.redacts} is from blacklisted user ${event.sender}, ignoring.`);
            return;
        }
        log.info(`Got redact request for ${event.redacts}`);
        log.verbose(`Event:`, event);

        const storeEvent = await this.store.Get(DbEvent, {matrix_id: `${event.redacts};${event.room_id}`});

        if (!storeEvent || !storeEvent.Result) {
            log.warn(`Could not redact because the event was not in the store.`);
            return;
        }
        log.info(`Redact event matched ${storeEvent.ResultCount} entries`);
        while (storeEvent.Next()) {
            log.info(`Deleting discord msg ${storeEvent.DiscordId}`);
            const result = await this.LookupRoom(storeEvent.GuildId, storeEvent.ChannelId, event.sender);
            const chan = result.channel;

            const msg = await chan.messages.fetch(storeEvent.DiscordId);
            try {
                this.channelLock.set(msg.channel.id);
                await msg.delete();
                this.channelLock.release(msg.channel.id);
                log.info(`Deleted message`);
            } catch (ex) {
                log.warn(`Failed to delete message`, ex);
            }
        }
    }

    public OnUserQuery(userId: string): boolean {
        return false;
    }

    public async GetDiscordUserOrMember(
        userId: Discord.Snowflake, guildId?: Discord.Snowflake,
    ): Promise<Discord.User|Discord.GuildMember|undefined> {
        try {
            const guild = guildId && await this.bot.guilds.fetch(guildId);
            if (guild) {
                return await guild.members.fetch(userId);
            }
            return await this.bot.users.fetch(userId);
        } catch (ex) {
            log.warn(`Could not fetch user data for ${userId} (guild: ${guildId})`);
            return undefined;
        }
    }

    public async GetChannelFromRoomId(roomId: string, client?: Discord.Client): Promise<Discord.Channel> {
        const entries = await this.store.roomStore.getEntriesByMatrixId(
            roomId,
        );

        if (!client) {
            client = this.bot;
        }

        if (entries.length === 0) {
            log.verbose(`Couldn"t find channel for roomId ${roomId}.`);
            throw Error("Room(s) not found.");
        }
        const entry = entries[0];
        if (!entry.remote) {
            throw Error("Room had no remote component");
        }
        const guild = await client.guilds.fetch(entry.remote!.get("discord_guild") as string);
        if (guild) {
            const channel = await client.channels.fetch(entry.remote!.get("discord_channel") as string);
            if (channel) {
                this.ClientFactory.bindMetricsToChannel(channel as Discord.TextChannel);
                return channel;
            }
            throw Error("Channel given in room entry not found");
        }
        throw Error("Guild given in room entry not found");
    }

    public async GetEmoji(name: string, animated: boolean, id: string): Promise<string> {
        if (!id.match(/^\d+$/)) {
            throw new Error("Non-numerical ID");
        }
        const dbEmoji = await this.store.Get(DbEmoji, {emoji_id: id});
        if (!dbEmoji) {
            throw new Error("Couldn't fetch from store");
        }
        if (!dbEmoji.Result) {
            const url = `https://cdn.discordapp.com/emojis/${id}${animated ? ".gif" : ".png"}`;
            const intent = this.bridge.botIntent;
            const content = (await Util.DownloadFile(url)).buffer;
            const type = animated ? "image/gif" : "image/png";
            const mxcUrl = await this.bridge.botIntent.underlyingClient.uploadContent(content, type, name);
            dbEmoji.EmojiId = id;
            dbEmoji.Name = name;
            dbEmoji.Animated = animated;
            dbEmoji.MxcUrl = mxcUrl;
            await this.store.Insert(dbEmoji);
        }
        return dbEmoji.MxcUrl;
    }

    public async GetRoomIdsFromGuild(
            guild: Discord.Guild, member?: Discord.GuildMember, useCache: boolean = true): Promise<string[]> {
        if (useCache) {
            const res = this.roomIdsForGuildCache.get(`${guild.id}:${member ? member.id : ""}`);

            if (res && res.ts > Date.now() - CACHE_LIFETIME) {
                return res.roomIds;
            }
        }

        if (member) {
            let rooms: string[] = [];
            await Util.AsyncForEach(guild.channels.cache.array(), async (channel) => {
                if (channel.type !== "text" || !channel.members.has(member.id)) {
                    return;
                }
                try {
                    rooms = rooms.concat(await this.channelSync.GetRoomIdsFromChannel(channel));
                } catch (e) { } // no bridged rooms for this channel
            });
            if (rooms.length === 0) {
                log.verbose(`No rooms were found for this guild and member (guild:${guild.id} member:${member.id})`);
                throw new Error("Room(s) not found.");
            }
            this.roomIdsForGuildCache.set(`${guild.id}:${guild.member}`, {roomIds: rooms, ts: Date.now()});
            return rooms;
        } else {
            const rooms = await this.store.roomStore.getEntriesByRemoteRoomData({
                discord_guild: guild.id,
            });
            if (rooms.length === 0) {
                log.verbose(`Couldn't find room(s) for guild id:${guild.id}.`);
                throw new Error("Room(s) not found.");
            }
            const roomIds = rooms.map((room) => room.matrix!.getId());
            this.roomIdsForGuildCache.set(`${guild.id}:`, {roomIds, ts: Date.now()});
            return roomIds;
        }
    }

    public async HandleMatrixKickBan(
        roomId: string, kickeeUserId: string, kicker: string, kickban: "leave"|"ban",
        previousState: string, reason?: string,
    ) {
        const restore = kickban === "leave" && previousState === "ban";
        const client = await this.clientFactory.getClient(kicker);
        let channel: Discord.Channel;
        try {
            channel = await this.GetChannelFromRoomId(roomId, client);
        } catch (ex) {
            log.error("Failed to get channel for ", roomId, ex);
            return;
        }
        if (channel.type !== "text") {
            log.warn("Channel was not a text channel");
            return;
        }
        const tchan = (channel as Discord.TextChannel);
        const kickeeUser = await this.GetDiscordUserOrMember(
            kickeeUserId.substring("@_discord_".length, kickeeUserId.indexOf(":") - 1),
            tchan.guild.id,
        );
        if (!kickeeUser) {
            log.error("Could not find discord user for", kickeeUserId);
            return;
        }
        const kickee = kickeeUser as Discord.GuildMember;
        let res: Discord.Message;
        const botChannel = await this.GetChannelFromRoomId(roomId) as Discord.TextChannel;
        if (restore) {
            await tchan.overwritePermissions([
                {
                    allow: ["SEND_MESSAGES", "VIEW_CHANNEL"],
                    id: kickee.id,
                }],
                `Unbanned.`,
            );
            this.channelLock.set(botChannel.id);
            res = await botChannel.send(
                `${kickee} was unbanned from this channel by ${kicker}.`,
            ) as Discord.Message;
            this.sentMessages.push(res.id);
            this.channelLock.release(botChannel.id);
            return;
        }
        const existingPerms = tchan.permissionsFor(kickee);
        if (existingPerms && existingPerms.has(Discord.Permissions.FLAGS.VIEW_CHANNEL as number) === false ) {
            log.warn("User isn't allowed to read anyway.");
            return;
        }
        const word = `${kickban === "ban" ? "banned" : "kicked"}`;
        this.channelLock.set(botChannel.id);
        res = await botChannel.send(
            `${kickee} was ${word} from this channel by ${kicker}.`
            + (reason ? ` Reason: ${reason}` : ""),
        ) as Discord.Message;
        this.sentMessages.push(res.id);
        this.channelLock.release(botChannel.id);
        log.info(`${word} ${kickee}`);

        await tchan.overwritePermissions([
            {
                deny: ["SEND_MESSAGES", "VIEW_CHANNEL"],
                id: kickee.id,
            }],
            `Matrix user was ${word} by ${kicker}.`,
        );
        if (kickban === "leave") {
            // Kicks will let the user back in after ~30 seconds.
            setTimeout(async () => {
                log.info(`Kick was lifted for ${kickee.displayName}`);
                await tchan.overwritePermissions([
                    {
                        allow: ["SEND_MESSAGES", "VIEW_CHANNEL"],
                        id: kickee.id,
                    }],
                    `Lifting kick since duration expired.`,
                );
            }, this.config.room.kickFor);
        }
    }

    public async GetEmojiByMxc(mxc: string): Promise<DbEmoji> {
        const dbEmoji = await this.store.Get(DbEmoji, {mxc_url: mxc});
        if (!dbEmoji || !dbEmoji.Result) {
            throw new Error("Couldn't fetch from store");
        }
        return dbEmoji;
    }

    private prepareEmbedSetUserAccount(embedSet: IMatrixEventProcessorResult): string {
        const embed = embedSet.messageEmbed;
        let addText = "";
        if (embedSet.replyEmbed) {
            for (const line of embedSet.replyEmbed.description!.split("\n")) {
                addText += "\n> " + line;
            }
        }
        return embed.description += addText;
    }

    private prepareEmbedSetBotAccount(embedSet: IMatrixEventProcessorResult): Discord.MessageEmbed | undefined {
        if (!embedSet.imageEmbed && !embedSet.replyEmbed) {
            return undefined;
        }
        let sendEmbed = new Discord.MessageEmbed();
        if (embedSet.imageEmbed) {
            if (!embedSet.replyEmbed) {
                sendEmbed = embedSet.imageEmbed;
            } else {
                sendEmbed.setImage(embedSet.imageEmbed.image!.url);
            }
        }
        if (embedSet.replyEmbed) {
            if (!embedSet.imageEmbed) {
                sendEmbed = embedSet.replyEmbed;
            } else {
                sendEmbed.addField("Replying to", embedSet.replyEmbed!.author!.name);
                sendEmbed.addField("Reply text", embedSet.replyEmbed.description);
            }
        }
        return sendEmbed;
    }

    private prepareEmbedSetWebhook(embedSet: IMatrixEventProcessorResult): Discord.MessageEmbed[] {
        const embeds: Discord.MessageEmbed[] = [];
        if (embedSet.imageEmbed) {
            embeds.push(embedSet.imageEmbed);
        }
        if (embedSet.replyEmbed) {
            embeds.push(embedSet.replyEmbed);
        }
        return embeds;
    }

    private prepareEmbedSetBot(embedSet: IMatrixEventProcessorResult): Discord.MessageEmbed {
        const embed = embedSet.messageEmbed;
        if (embedSet.imageEmbed) {
            embed.setImage(embedSet.imageEmbed.image!.url);
        }
        if (embedSet.replyEmbed) {
            embed.addField("Replying to", embedSet.replyEmbed!.author!.name);
            embed.addField("Reply text", embedSet.replyEmbed.description);
        }
        return embed;
    }

    private async SendMatrixMessage(matrixMsg: IDiscordMessageParserResult, chan: Discord.Channel,
                                    guild: Discord.Guild, author: Discord.User,
                                    msgID: string): Promise<boolean> {
        const rooms = await this.channelSync.GetRoomIdsFromChannel(chan);
        const intent = this.GetIntentFromDiscordMember(author);

        await Util.AsyncForEach(rooms, async (roomId) => {
            const eventId = await intent.sendEvent(roomId, {
                body: matrixMsg.body,
                format: "org.matrix.custom.html",
                formatted_body: matrixMsg.formattedBody,
                msgtype: "m.text",
            });
            this.lastEventIds[roomId] = eventId;
            const evt = new DbEvent();
            evt.MatrixId = `${eventId};${roomId}`;
            evt.DiscordId = msgID;
            evt.ChannelId = chan.id;
            evt.GuildId = guild.id;
            await this.store.Insert(evt);
        });

        // Sending was a success
        return true;
    }

    private async OnTyping(channel: Discord.Channel, user: Discord.User|Discord.PartialUser, isTyping: boolean) {
        const rooms = await this.channelSync.GetRoomIdsFromChannel(channel);
        try {
            const intent = this.GetIntentFromDiscordMember(user);
            await intent.ensureRegistered();
            await Promise.all(rooms.map( async (roomId) => {
                return intent.underlyingClient.setTyping(roomId, isTyping);
            }));
            const typingKey = `${user.id}:${channel.id}`;
            if (isTyping) {
                if (this.typingTimers[typingKey]) {
                    clearTimeout(this.typingTimers[typingKey]);
                }
                this.typingTimers[typingKey] = setTimeout(async () => {
                    this.OnTyping(channel, user, false).catch((ex) => {
                        log.error(`Failed to reset typing after ${TYPING_TIMEOUT_MS}ms for ${user.id}`);
                    });
                    delete this.typingTimers[typingKey];
                }, TYPING_TIMEOUT_MS);
            }
        } catch (err) {
            log.warn("Failed to send typing indicator.", err);
        }
    }

    private async OnMessage(msg: Discord.Message, editEventId: string = "") {
        const indexOfMsg = this.sentMessages.indexOf(msg.id);
        if (indexOfMsg !== -1) {
            log.verbose("Got repeated message, ignoring.");
            delete this.sentMessages[indexOfMsg];
            MetricPeg.get.requestOutcome(msg.id, true, "dropped");
            return; // Skip *our* messages
        }
        const chan = msg.channel as Discord.TextChannel;
        if (msg.author.id === this.bot.user?.id) {
            // We don't support double bridging.
            log.verbose("Not reflecting bot's own messages");
            MetricPeg.get.requestOutcome(msg.id, true, "dropped");
            return;
        }
        // Test for webhooks
        if (msg.webhookID) {
            const webhook = (await chan.fetchWebhooks())
                            .filter((h) => h.name === "_matrix").first();
            if (webhook && msg.webhookID === webhook.id) {
                // Filter out our own webhook messages.
                log.verbose("Not reflecting own webhook messages");
              // Filter out our own webhook messages.
                MetricPeg.get.requestOutcome(msg.id, true, "dropped");
                return;
            }
        }

        // check if it is a command to process by the bot itself
        if (msg.content.startsWith("!matrix")) {
            await this.discordCommandHandler.Process(msg);
            MetricPeg.get.requestOutcome(msg.id, true, "success");
            return;
        }

        // Update presence because sometimes discord misses people.
        await this.userSync.OnUpdateUser(msg.author, Boolean(msg.webhookID));
        let rooms: string[];
        try {
            rooms = await this.channelSync.GetRoomIdsFromChannel(msg.channel);
            if (rooms === null) {
                throw Error();
            }
        } catch (err) {
            log.verbose("No bridged rooms to send message to. Oh well.");
            MetricPeg.get.requestOutcome(msg.id, true, "dropped");
            return null;
        }
        try {
            const intent = this.GetIntentFromDiscordMember(msg.author, msg.webhookID);
            // Check Attachements
            if (!editEventId) {
                // on discord you can't edit in images, you can only edit text
                // so it is safe to only check image upload stuff if we don't have
                // an edit
                await Util.AsyncForEach(msg.attachments.array(), async (attachment) => {
                    const content = await Util.DownloadFile(attachment.url);
                    const fileMime = content.mimeType || mime.getType(attachment.name || "")
                        || "application/octet-stream";
                    const mxcUrl = await intent.underlyingClient.uploadContent(
                        content.buffer,
                        fileMime,
                        attachment.name || "",
                    );
                    const type = fileMime.split("/")[0];
                    let msgtype = {
                        audio: "m.audio",
                        image: "m.image",
                        video: "m.video",
                    }[type];
                    if (!msgtype) {
                        msgtype = "m.file";
                    }
                    const info = {
                        mimetype: fileMime,
                        size: attachment.size,
                    } as IMatrixMediaInfo;
                    if (msgtype === "m.image" || msgtype === "m.video") {
                        info.w = attachment.width!;
                        info.h = attachment.height!;
                    }
                    await Util.AsyncForEach(rooms, async (room) => {
                        const eventId = await intent.sendEvent(room, {
                            body: attachment.name || "file",
                            external_url: attachment.url,
                            info,
                            msgtype,
                            url: mxcUrl,
                        });
                        this.lastEventIds[room] = eventId;
                        const evt = new DbEvent();
                        evt.MatrixId = `${eventId};${room}`;
                        evt.DiscordId = msg.id;
                        evt.ChannelId = msg.channel.id;
                        if (msg.guild) {
                            evt.GuildId = msg.guild.id;
                        }
                        await this.store.Insert(evt);
                    });
                });
            }
            if (!msg.content && msg.embeds.length === 0) {
                return;
            }
            const result = await this.discordMsgProcessor.FormatMessage(msg);
            if (!result.body) {
                return;
            }
            await Util.AsyncForEach(rooms, async (room) => {
                const sendContent: IMatrixMessage = {
                    body: result.body,
                    format: "org.matrix.custom.html",
                    formatted_body: result.formattedBody,
                    msgtype: result.msgtype,
                };
                if (editEventId) {
                    sendContent.body = `* ${result.body}`;
                    sendContent.formatted_body = `* ${result.formattedBody}`;
                    sendContent["m.new_content"] = {
                        body: result.body,
                        format: "org.matrix.custom.html",
                        formatted_body: result.formattedBody,
                        msgtype: result.msgtype,
                    };
                    sendContent["m.relates_to"] = {
                        event_id: editEventId,
                        rel_type: "m.replace",
                    };
                }
                const trySend = async () =>  intent.sendEvent(room, sendContent);
                const afterSend = async (eventId) => {
                    this.lastEventIds[room] = eventId;
                    const evt = new DbEvent();
                    evt.MatrixId = `${eventId};${room}`;
                    evt.DiscordId = msg.id;
                    evt.ChannelId = msg.channel.id;
                    if (msg.guild) {
                        evt.GuildId = msg.guild.id;
                    }
                    await this.store.Insert(evt);
                };
                let res;
                try {
                    res = await trySend();
                    await afterSend(res);
                } catch (e) {
                    if (e.errcode !== "M_FORBIDDEN" && e.errcode !==  "M_GUEST_ACCESS_FORBIDDEN") {
                        log.error("Failed to send message into room.", e);
                        return;
                    }
                    if (msg.member && !msg.webhookID) {
                        await this.userSync.JoinRoom(msg.member, room);
                    } else {
                        await this.userSync.JoinRoom(msg.author, room, Boolean(msg.webhookID));
                    }
                    res = await trySend();
                    await afterSend(res);
                }
            });
            MetricPeg.get.requestOutcome(msg.id, true, "success");
        } catch (err) {
            MetricPeg.get.requestOutcome(msg.id, true, "fail");
            log.verbose("Failed to send message into room.", err);
        }
    }

    private async OnMessageUpdate(oldMsg: Discord.Message, newMsg: Discord.Message) {
        // Check if an edit was actually made
        if (oldMsg.content === newMsg.content) {
            return;
        }
        log.info(`Got edit event for ${newMsg.id}`);
        const storeEvent = await this.store.Get(DbEvent, {discord_id: oldMsg.id});
        if (storeEvent && storeEvent.Result) {
            while (storeEvent.Next()) {
                const matrixIds = storeEvent.MatrixId.split(";");
                await this.OnMessage(newMsg, matrixIds[0]);
                return;
            }
        }
        newMsg.content = `Edit: ${newMsg.content}`;
        await this.OnMessage(newMsg);
    }

    private async DeleteDiscordMessage(msg: Discord.Message) {
        log.info(`Got delete event for ${msg.id}`);
        const storeEvent = await this.store.Get(DbEvent, {discord_id: msg.id});
        if (!storeEvent || !storeEvent.Result) {
            log.warn(`Could not redact because the event was not in the store.`);
            return;
        }
        while (storeEvent.Next()) {
            log.info(`Deleting discord msg ${storeEvent.DiscordId}`);
            const intent = this.GetIntentFromDiscordMember(msg.author, msg.webhookID);
            await intent.ensureRegistered();
            const matrixIds = storeEvent.MatrixId.split(";");
            try {
                await intent.underlyingClient.redactEvent(matrixIds[1], matrixIds[0]);
            } catch (ex) {
                log.warn(`Failed to delete ${storeEvent.DiscordId}, retrying as bot`);
                try {
                    await this.bridge.botIntent.underlyingClient.redactEvent(matrixIds[1], matrixIds[0]);
                } catch (ex) {
                    log.warn(`Failed to delete ${storeEvent.DiscordId}, giving up`);
                }
            }
        }
    }

    private async StoreMessagesSent(
        msg: Discord.Message | null | (Discord.Message | null)[],
        chan: Discord.TextChannel,
        event: IMatrixEvent,
    ) {
        if (!Array.isArray(msg)) {
            msg = [msg];
        }
        await Util.AsyncForEach(msg, async (m: Discord.Message) => {
            if (!m) {
                return;
            }
            log.verbose("Sent ", m.id);
            this.sentMessages.push(m.id);
            this.lastEventIds[chan.id] = m.id;
            try {
                const evt = new DbEvent();
                evt.MatrixId = `${event.event_id};${event.room_id}`;
                evt.DiscordId = m.id;
                evt.GuildId = chan.guild.id;
                evt.ChannelId = chan.id;
                await this.store.Insert(evt);
            } catch (err) {
                log.error(`Failed to insert sent event (${event.event_id};${event.room_id}) into store`, err);
            }
        });
    }
}
