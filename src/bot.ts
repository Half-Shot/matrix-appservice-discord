import { DiscordBridgeConfig } from "./config";
import { DiscordClientFactory } from "./clientfactory";
import { DiscordStore } from "./store";
import { DbEmoji } from "./db/dbdataemoji";
import { DbEvent } from "./db/dbdataevent";
import { MatrixUser, RemoteUser, Bridge, Entry } from "matrix-appservice-bridge";
import { Util } from "./util";
import { MessageProcessor, MessageProcessorOpts, MessageProcessorMatrixResult } from "./messageprocessor";
import { MatrixEventProcessor, MatrixEventProcessorOpts } from "./matrixeventprocessor";
import { PresenceHandler } from "./presencehandler";
import { Provisioner } from "./provisioner";
import { UserSyncroniser } from "./usersyncroniser";
import { ChannelSyncroniser } from "./channelsyncroniser";
import { DMHandler } from "./dmhandler";
import { MatrixRoomHandler } from "./matrixroomhandler";
import { Log } from "./log";
import * as Discord from "discord.js";
import * as Bluebird from "bluebird";
import * as mime from "mime";

const log = new Log("DiscordBot");

// Due to messages often arriving before we get a response from the send call,
// messages get delayed from discord.
const MSG_PROCESS_DELAY = 750;
const MIN_PRESENCE_UPDATE_DELAY = 250;

// TODO: This is bad. We should be serving the icon from the own homeserver.
const MATRIX_ICON_URL = "https://matrix.org/_matrix/media/r0/download/matrix.org/mlxoESwIsTbJrfXyAAogrNxA";
class ChannelLookupResult {
  public channel: Discord.GuildChannel;
  public botUser: boolean;
}

export class DiscordBot {
  private config: DiscordBridgeConfig;
  private clientFactory: DiscordClientFactory;
  private store: DiscordStore;
  private bot: Discord.Client;
  private bridge: Bridge;
  private presenceInterval: any;
  private sentMessages: string[];
  private msgProcessor: MessageProcessor;
  private mxEventProcessor: MatrixEventProcessor;
  private presenceHandler: PresenceHandler;
  private dmHandler: DMHandler;
  private userSync: UserSyncroniser;
  private channelSync: ChannelSyncroniser;
  private roomHandler: MatrixRoomHandler;

  constructor(config: DiscordBridgeConfig, store: DiscordStore, private provisioner: Provisioner) {
    this.config = config;
    this.store = store;
    this.sentMessages = [];
    this.clientFactory = new DiscordClientFactory(store, config.auth);
    this.msgProcessor = new MessageProcessor(
      new MessageProcessorOpts(this.config.bridge.domain, this),
    );
    this.presenceHandler = new PresenceHandler(this);
  }

  public setBridge(bridge: Bridge) {
    this.bridge = bridge;
    this.mxEventProcessor = new MatrixEventProcessor(
        new MatrixEventProcessorOpts(this.config, bridge),
    );
  }

  public setRoomHandler(roomHandler: MatrixRoomHandler) {
    this.roomHandler = roomHandler;
  }

  get ClientFactory(): DiscordClientFactory {
     return this.clientFactory;
  }

  get DMHandler(): DMHandler {
    return this.dmHandler;
  }

  get UserSyncroniser(): UserSyncroniser {
    return this.userSync;
  }

  get ChannelSyncroniser(): ChannelSyncroniser {
    return this.channelSync;
  }

  public GetIntentFromDiscordMember(member: Discord.GuildMember | Discord.User): any {
      return this.bridge.getIntentFromLocalpart(`_discord_${member.id}`);
  }

  public run (): Promise<void> {
    return this.clientFactory.init().then(() => {
      return this.clientFactory.getClient();
    }).then((client: any) => {
      if (!this.config.bridge.disableTypingNotifications) {
        client.on("typingStart", (c, u) => { this.OnTyping(c, u, true); });
        client.on("typingStop", (c, u) => { this.OnTyping(c, u, false);  });
      }
      if (!this.config.bridge.disablePresence) {
        client.on("presenceUpdate", (_, newMember: Discord.GuildMember) => {
          this.presenceHandler.EnqueueUser(newMember.user);
        });
      }
      this.channelSync = new ChannelSyncroniser(this.bridge, this.config, this);
      client.on("channelUpdate", (_, newChannel) => { this.channelSync.OnUpdate(newChannel); });
      client.on("channelDelete", (channel) => { this.channelSync.OnDelete(channel); });
      client.on("guildUpdate", (_, newGuild) => { this.channelSync.OnGuildUpdate(newGuild); });
      client.on("guildDelete", (guild) => { this.channelSync.OnGuildDelete(guild); });

      client.on("messageDelete", (msg) => { this.DeleteDiscordMessage(msg); });
      client.on("messageUpdate", (oldMessage, newMessage) => { this.OnMessageUpdate(oldMessage, newMessage); });
      client.on("message", (msg) => { Bluebird.delay(MSG_PROCESS_DELAY).then(() => {
          this.OnMessage(msg);
        });
      });
      const jsLog = new Log("discord.js");

      this.userSync = new UserSyncroniser(this.bridge, this.config, this);
      client.on("userUpdate", (_, user) => this.userSync.OnUpdateUser(user));
      client.on("guildMemberAdd", (user) => this.userSync.OnAddGuildMember(user));
      client.on("guildMemberRemove", (user) =>  this.userSync.OnRemoveGuildMember(user));
      client.on("guildMemberUpdate", (oldUser, newUser) =>  this.userSync.OnUpdateGuildMember(oldUser, newUser));
      client.on("debug", (msg) => { jsLog.verbose(msg); });
      client.on("error", (msg) => { jsLog.error(msg); });
      client.on("warn", (msg) => { jsLog.warn(msg); });
      log.info("Discord bot client logged in.");
      this.bot = client;

      this.dmHandler = new DMHandler(
          this.config,
          this.bridge,
          this.clientFactory,
          this.store,
          this.userSync,
      );

      this.dmHandler.StartPuppetedClients().catch(() => {
        log.warn("Failed to start puppeted clients for DMs");
      });

      if (!this.config.bridge.disablePresence) {
        if (!this.config.bridge.presenceInterval) {
          this.config.bridge.presenceInterval = MIN_PRESENCE_UPDATE_DELAY;
        }
        this.bot.guilds.forEach((guild) => {
            guild.members.forEach((member) => {
                if (member.id !== this.GetBotId()) {
                  this.presenceHandler.EnqueueUser(member.user);
                }
            });
        });
        this.presenceHandler.Start(
            Math.max(this.config.bridge.presenceInterval, MIN_PRESENCE_UPDATE_DELAY),
        );
      }
    });
  }

  public GetBotId(): string {
    return this.bot.user.id;
  }

  public GetGuilds(): Discord.Guild[] {
    return this.bot.guilds.array();
  }

  public ThirdpartySearchForChannels(guildId: string, channelName: string): any[] {
    if (channelName.startsWith("#")) {
      channelName = channelName.substr(1);
    }
    if (this.bot.guilds.has(guildId) ) {
      const guild = this.bot.guilds.get(guildId);
      return guild.channels.filter((channel) => {
        return channel.name.toLowerCase() === channelName.toLowerCase(); // Implement searching in the future.
      }).map((channel) => {
        return {
          alias: `#_discord_${guild.id}_${channel.id}:${this.config.bridge.domain}`,
          protocol: "discord",
          fields: {
            guild_id: guild.id,
            channel_name: channel.name,
            channel_id: channel.id,
          },
        };
      });
    } else {
      log.info("Tried to do a third party lookup for a channel, but the guild did not exist");
      return [];
    }
  }

  public LookupRoom (server: string, room: string, sender?: string): Promise<ChannelLookupResult> {
    const hasSender = sender !== null;
    return this.clientFactory.getClient(sender).then((client) => {
      const guild = client.guilds.get(server);
      if (!guild) {
        throw `Guild "${server}" not found`;
      }
      const channel = guild.channels.get(room);
      if (channel) {
        const lookupResult = new ChannelLookupResult();
        lookupResult.channel = channel;
        lookupResult.botUser = this.bot.user.id === client.user.id;
        return lookupResult;
      }
      throw `Channel "${room}" not found`;
    }).catch((err) => {
      log.verbose("LookupRoom => ", err);
      if (hasSender) {
        log.verbose(`Couldn't find guild/channel under user account. Falling back.`);
        return this.LookupRoom(server, room, null);
      }
      throw err;
    });
  }

  public async ProcessMatrixStateEvent(event: any): Promise<void> {
      log.verbose(`Got state event from ${event.room_id} ${event.type}`);
      const channel = <Discord.TextChannel> await this.GetChannelFromRoomId(event.room_id);
      const msg = this.mxEventProcessor.StateEventToMessage(event, channel);
      if (!msg) {
          return;
      }
      let res = await channel.send(msg);
      if (!Array.isArray(res)) {
        res = [res];
      }
      res.forEach((m: Discord.Message) => {
        log.verbose("Sent (state msg) ", m);
        this.sentMessages.push(m.id);
        const evt = new DbEvent();
        evt.MatrixId = event.event_id + ";" + event.room_id;
        evt.DiscordId = m.id;
        evt.GuildId = channel.guild.id;
        evt.ChannelId = channel.id;
        return this.store.Insert(evt);
      });
  }

  public async ProcessMatrixMsgEvent(event: any, guildId: string, channelId: string): Promise<null> {
    const mxClient = this.bridge.getClientFactory().getClientAs();
    log.verbose(`Looking up ${guildId}_${channelId}`);
    const result = await this.LookupRoom(guildId, channelId, event.sender);
    const chan = result.channel;
    const botUser = result.botUser;
    let profile = null;
    if (result.botUser) {
        // We are doing this through webhooks so fetch the user profile.
        profile = await mxClient.getStateEvent(event.room_id, "m.room.member", event.sender);
        if (profile === null) {
          log.warn(`User ${event.sender} has no member state. That's odd.`);
        }
    }
    const embed = this.mxEventProcessor.EventToEmbed(event, profile, chan);
    const opts: Discord.MessageOptions = {};
    const file = await this.mxEventProcessor.HandleAttachment(event, mxClient);
    if (typeof(file) === "string") {
        embed.description += " " + file;
    } else {
        opts.file = file;
    }

    let msg = null;
    let hook: Discord.Webhook ;
    if (botUser) {
      const webhooks = await chan.fetchWebhooks();
      hook = webhooks.filterArray((h) => h.name === "_matrix").pop();
      // Create a new webhook if none already exists
      try {
        if (!hook) {
          hook = await chan.createWebhook("_matrix", MATRIX_ICON_URL, "Matrix Bridge: Allow rich user messages");
        }
      } catch (err) {
        log.error("Unable to create \"_matrix\" webhook. ", err);
      }
    }
    try {
      if (!botUser) {
        msg = await chan.send(embed.description, opts);
      } else if (hook) {
        msg = await hook.send(embed.description, {
            username: embed.author.name,
            avatarURL: embed.author.icon_url,
            file: opts.file,
        });
      } else {
        opts.embed = embed;
        msg = await chan.send("", opts);
      }
    } catch (err) {
      log.error("Couldn't send message. ", err);
    }
    if (!Array.isArray(msg)) {
      msg = [msg];
    }
    msg.forEach((m: Discord.Message) => {
      log.verbose("Sent ", m);
      this.sentMessages.push(m.id);
      const evt = new DbEvent();
      evt.MatrixId = event.event_id + ";" + event.room_id;
      evt.DiscordId = m.id;
      // Webhooks don't send guild info.
      evt.GuildId = guildId;
      evt.ChannelId = channelId;
      return this.store.Insert(evt);
    });
    return;
  }

  public async ProcessMatrixRedact(event: any) {
    if (this.config.bridge.disableDeletionForwarding) {
      return;
    }
    log.info(`Got redact request for ${event.redacts}`);
    log.verbose(`Event:`, event);

    const storeEvent = await this.store.Get(DbEvent, {matrix_id: event.redacts + ";" + event.room_id});

    if (!storeEvent.Result) {
      log.warn(`Could not redact because the event was not in the store.`);
      return;
    }
    log.info(`Redact event matched ${storeEvent.ResultCount} entries`);
    while (storeEvent.Next()) {
      log.info(`Deleting discord msg ${storeEvent.DiscordId}`);
      const result = await this.LookupRoom(storeEvent.GuildId, storeEvent.ChannelId, event.sender);
      const chan = result.channel;

      const msg = await chan.fetchMessage(storeEvent.DiscordId);
      try {
        await msg.delete();
        log.info(`Deleted message`);
      } catch (ex) {
        log.warn(`Failed to delete message`, ex);
      }
    }
  }

  public OnUserQuery (userId: string): any {
    return false;
  }

  public GetChannelFromRoomId(roomId: string): Promise<Discord.Channel> {
    return this.bridge.getRoomStore().getEntriesByMatrixId(
      roomId,
    ).then((entries) => {
      if (entries.length === 0) {
        log.verbose(`Couldn"t find channel for roomId ${roomId}.`);
        return Promise.reject("Room(s) not found.");
      }
      const entry = entries[0];
      const guild = this.bot.guilds.get(entry.remote.get("discord_guild"));
      if (guild) {
        const channel = this.bot.channels.get(entry.remote.get("discord_channel"));
        if (channel) {
          return channel;
        }
        throw Error("Channel given in room entry not found");
      }
      throw Error("Guild given in room entry not found");
    });
  }

  public async GetEmoji(name: string, animated: boolean, id: string): Promise<string> {
    if (!id.match(/^\d+$/)) {
      throw new Error("Non-numerical ID");
    }
    const dbEmoji: DbEmoji = await this.store.Get(DbEmoji, {emoji_id: id});
    if (!dbEmoji.Result) {
      const url = "https://cdn.discordapp.com/emojis/" + id + (animated ? ".gif" : ".png");
      const intent = this.bridge.getIntent();
      const mxcUrl = (await Util.UploadContentFromUrl(url, intent, name)).mxcUrl;
      dbEmoji.EmojiId = id;
      dbEmoji.Name = name;
      dbEmoji.Animated = animated;
      dbEmoji.MxcUrl = mxcUrl;
      await this.store.Insert(dbEmoji);
    }
    return dbEmoji.MxcUrl;
  }

  public GetRoomIdsFromGuild(guild: String): Promise<string[]> {
    return this.bridge.getRoomStore().getEntriesByRemoteRoomData({
      discord_guild: guild,
    }).then((rooms) => {
      if (rooms.length === 0) {
        log.verbose(`Couldn't find room(s) for guild id:${guild}.`);
        return Promise.reject("Room(s) not found.");
      }
      return rooms.map((room) => room.matrix.getId());
    });
  }

  private async StoreMatrixEvent(res: any, room: string, chan: Discord.GuildChannel, msgID: string) {
      const dbEvt = new DbEvent();
      dbEvt.MatrixId = res.event_id + ";" + room;
      dbEvt.DiscordId = msgID;
      dbEvt.ChannelId = chan.id;
      dbEvt.GuildId = chan.guild.id;
      return this.store.Insert(dbEvt).catch((err) => {
          log.warn("Failed to insert sent event into the database", err);
      });
  }

  private async SendMatrixMessage(matrixMsg: MessageProcessorMatrixResult, chan: Discord.GuildChannel,
                                  author: Discord.User|Discord.GuildMember,
                                  msgID: string): Promise<boolean> {
    const rooms = await this.channelSync.GetRoomIdsFromChannel(chan);
    const intent = this.GetIntentFromDiscordMember(author);
    const textEvt = {
      body: matrixMsg.body,
      msgtype: "m.text",
      formatted_body: matrixMsg.formattedBody,
      format: "org.matrix.custom.html",
    };
    let res;
    const msgsToSend = Array.from(matrixMsg.attachmentEvents);
    msgsToSend.push(textEvt);
    let failuresToSend = 0;
    while (rooms.length > 0) {
        const room = rooms[0];
        try {
            for (const evt of msgsToSend) {
                res = await intent.sendMessage(room, evt);
                await this.StoreMatrixEvent(res, room, chan, msgID);
            }
            failuresToSend = 0;
        } catch (e) {
            log.warn(`Failed to send: ${author.id} -> ${room}`);
            if (e.errcode !== "M_FORBIDDEN") {
              log.error("DiscordBot", "Failed to send message into room.", e);
              return;
            }
            // TODO: Should we ensure that the MembershipCache knows, to avoid no-oping this?
            if (author instanceof Discord.GuildMember) {
                log.info(`Ensuring ${author.id} is joined to ${room}.`);
                try {
                    await this.userSync.EnsureJoin(author, room);
                    rooms.push(room);
                } catch (ex) {
                    log.error(
                        `Failed to join ${author.id} to ${room} after failure to send message. Giving up.`
                    );
                }
            }
        }
        rooms.splice(0, 1);
    }
    // Sending was a success
    return true;
  }

  private OnTyping(channel: Discord.Channel, user: Discord.User, isTyping: boolean) {
    this.channelSync.GetRoomIdsFromChannel(channel).then((rooms) => {
      const intent = this.GetIntentFromDiscordMember(user);
      return Promise.all(rooms.map((room) => {
        return intent.sendTyping(room, isTyping);
      }));
    }).catch((err) => {
      log.warn("Failed to send typing indicator.", err);
    });
  }

  private async OnMessage(msg: Discord.Message) {
    const indexOfMsg = this.sentMessages.indexOf(msg.id);
    const chan = <Discord.TextChannel> msg.channel;
    if (indexOfMsg !== -1) {
      log.verbose("Got repeated message, ignoring.");
      delete this.sentMessages[indexOfMsg];
      return; // Skip *our* messages
    }
    if (msg.author.id === this.bot.user.id) {
      // We don't support double bridging.
      return;
    }
    // Issue #57: Detect webhooks
    if (msg.webhookID != null) {
      const webhook = (await chan.fetchWebhooks())
                      .filterArray((h) => h.name === "_matrix").pop();
      if (webhook != null && msg.webhookID === webhook.id) {
        // Filter out our own webhook messages.
        return;
      }
    }

    // Check if there's an ongoing bridge request
    if ((msg.content === "!approve" || msg.content === "!deny") && this.provisioner.HasPendingRequest(chan)) {
      try {
        const isApproved = msg.content === "!approve";
        const successfullyBridged = await this.provisioner.MarkApproved(chan, msg.member, isApproved);
        if (successfullyBridged && isApproved) {
          msg.channel.sendMessage("Thanks for your response! The matrix bridge has been approved");
        } else if (successfullyBridged && !isApproved) {
          msg.channel.sendMessage("Thanks for your response! The matrix bridge has been declined");
        } else {
          msg.channel.sendMessage("Thanks for your response, however the time for responses has expired - sorry!");
        }
      } catch (err) {
        if (err.message === "You do not have permission to manage webhooks in this channel") {
          msg.channel.sendMessage(err.message);
        } else {
          log.error("Error processing room approval");
          log.error(err);
        }
      }

      return; // stop processing - we're approving/declining the bridge request
    }

    // check if it is a command to process by the bot itself
    if (msg.content.startsWith("!matrix")) {
      await this.roomHandler.HandleDiscordCommand(msg);
      return;
    }

    // Update presence because sometimes discord misses people.
    await this.userSync.OnUpdateUser(msg.author);
    let rooms = null;
    try {
      rooms = await this.ChannelSyncroniser.GetRoomIdsFromChannel(msg.channel);
    } catch (e) {
      log.verbose("No bridged rooms to send message to. Oh well.");
    }
    if (rooms === null) {
      return null;
    }
    const intent = this.GetIntentFromDiscordMember(msg.author);
    const result = await this.msgProcessor.FormatDiscordMessage(msg, intent);
    try {
      await this.SendMatrixMessage(result, <Discord.GuildChannel> msg.channel, msg.member, msg.id);
    } catch (e) {
      log.verbose("Failed to send message into room.", e);
    }
  }

  private async OnMessageUpdate(oldMsg: Discord.Message, newMsg: Discord.Message) {
    // Check if an edit was actually made
    if (oldMsg.content === newMsg.content) {
      return;
    }

    // Create a new edit message using the old and new message contents
    const editedMsg = await this.msgProcessor.FormatEdit(oldMsg, newMsg);

    // Send the message to all bridged matrix rooms
    if (!await this.SendMatrixMessage(editedMsg, <Discord.GuildChannel> newMsg.channel, newMsg.author, newMsg.id)) {
      log.error("Unable to announce message edit for msg id:", newMsg.id);
    }
  }

    private async DeleteDiscordMessage(msg: Discord.Message) {
        log.info(`Got delete event for ${msg.id}`);
        const storeEvent = await this.store.Get(DbEvent, {discord_id: msg.id});
        if (!storeEvent.Result) {
          log.warn(`Could not redact because the event was not in the store.`);
          return;
        }
        while (storeEvent.Next()) {
          log.info(`Deleting discord msg ${storeEvent.DiscordId}`);
          const intent = this.GetIntentFromDiscordMember(msg.author);
          const matrixIds = storeEvent.MatrixId.split(";");
          await intent.getClient().redactEvent(matrixIds[1], matrixIds[0]);
        }
    }
}
