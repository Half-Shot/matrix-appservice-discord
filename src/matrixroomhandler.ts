import { DiscordBot } from "./bot";
import {
  Bridge,
  RemoteRoom,
  thirdPartyLookup,
  thirdPartyProtocolResult,
  thirdPartyUserResult,
  thirdPartyLocationResult,
 } from "matrix-appservice-bridge";
import { DiscordBridgeConfig } from "./config";

import * as Discord from "discord.js";
import * as Bluebird from "bluebird";
import { Util, ICommandActions, ICommandParameters } from "./util";
import { Provisioner } from "./provisioner";
import { Log } from "./log";
const log = new Log("MatrixRoomHandler");

const ICON_URL = "https://matrix.org/_matrix/media/r0/download/matrix.org/mlxoESwIsTbJrfXyAAogrNxA";
const HTTP_UNSUPPORTED = 501;
const ROOM_NAME_PARTS = 2;
const AGE_LIMIT = 900000; // 15 * 60 * 1000
const PROVISIONING_DEFAULT_POWER_LEVEL = 50;
const PROVISIONING_DEFAULT_USER_POWER_LEVEL = 0;
const USERSYNC_STATE_DELAY_MS = 5000;

// Note: The schedule must not have duplicate values to avoid problems in positioning.
/* tslint:disable:no-magic-numbers */ // Disabled because it complains about the values in the array
const JOIN_ROOM_SCHEDULE = [
    0,              // Right away
    1000,           // 1 second
    30000,          // 30 seconds
    300000,         // 5 minutes
    900000,         // 15 minutes
];
/* tslint:enable:no-magic-numbers */

export class MatrixRoomHandler {

  private config: DiscordBridgeConfig;
  private bridge: Bridge;
  private discord: DiscordBot;
  private botUserId: string;
  constructor (
      discord: DiscordBot,
      config: DiscordBridgeConfig,
      botUserId: string,
      private provisioner: Provisioner,
  ) {
    this.discord = discord;
    this.config = config;
    this.botUserId = botUserId;
  }

  public get ThirdPartyLookup(): thirdPartyLookup {
    return {
      protocols: ["discord"],
      getProtocol: this.tpGetProtocol.bind(this),
      getLocation: this.tpGetLocation.bind(this),
      parseLocation: this.tpParseLocation.bind(this),
      getUser: this.tpGetUser.bind(this),
      parseUser: this.tpParseUser.bind(this),
    };
  }

  public setBridge(bridge: Bridge) {
    this.bridge = bridge;
  }

  public async OnAliasQueried (alias: string, roomId: string) {
    log.verbose("OnAliasQueried", `Got OnAliasQueried for ${alias} ${roomId}`);
    const channel = await this.discord.GetChannelFromRoomId(roomId) as Discord.GuildChannel;

    // Fire and forget RoomDirectory mapping
    this.bridge.getIntent().getClient().setRoomDirectoryVisibilityAppService(
        channel.guild.id,
        roomId,
        "public",
    );
    await this.discord.ChannelSyncroniser.OnUpdate(channel);
    let promiseChain: Bluebird<any> = Bluebird.resolve();
    /* We delay the joins to give some implementations a chance to breathe */
    // Join a whole bunch of users.
    /* We delay the joins to give some implementations a chance to breathe */
    let delay = this.config.limits.roomGhostJoinDelay;
    for (const member of (<Discord.TextChannel> channel).members.array()) {
        if (member.id === this.discord.GetBotId()) {
          continue;
        }
        promiseChain = promiseChain.return(Bluebird.delay(delay).then(() => {
            log.info("OnAliasQueried", `UserSyncing ${member.id}`);
            // Ensure the profile is up to date.
            return this.discord.UserSyncroniser.OnUpdateUser(member.user);
        }).then(() => {
            log.info("OnAliasQueried", `Joining ${member.id} to ${roomId}`);
            return this.joinRoom(this.discord.GetIntentFromDiscordMember(member), roomId)
                .then(() => {
                  // set the correct discord guild name
                  this.discord.UserSyncroniser.EnsureJoin(member, roomId);
                });
        }));
        delay += this.config.limits.roomGhostJoinDelay;
    }
    // tslint:disable-next-line:await-promise
    await promiseChain;
  }

  public OnEvent (request, context): Promise<any> {
    const event = request.getData();
    if (event.unsigned.age > AGE_LIMIT) {
      log.warn(`Skipping event due to age ${event.unsigned.age} > ${AGE_LIMIT}`);
      return Promise.reject("Event too old");
    }
    if (event.type === "m.room.member" && event.content.membership === "invite") {
      return this.HandleInvite(event);
    } else if (event.type === "m.room.member" && event.content.membership === "join") {
        if (this.bridge.getBot().isRemoteUser(event.state_key)) {
            return this.discord.UserSyncroniser.OnMemberState(event, USERSYNC_STATE_DELAY_MS);
        } else {
          return this.discord.ProcessMatrixStateEvent(event);
        }
    } else if (event.type === "m.room.member") {
      return this.discord.ProcessMatrixStateEvent(event);
    } else if (event.type === "m.room.name") {
      return this.discord.ProcessMatrixStateEvent(event);
    } else if (event.type === "m.room.topic") {
      return this.discord.ProcessMatrixStateEvent(event);
    } else if (event.type === "m.room.redaction" && context.rooms.remote) {
      return this.discord.ProcessMatrixRedact(event);
    } else if (event.type === "m.room.message" || event.type === "m.sticker") {
        log.verbose(`Got ${event.type} event`);
        if (event.type === "m.room.message" && event.content.body && event.content.body.startsWith("!discord")) {
            return this.ProcessCommand(event, context);
        } else if (context.rooms.remote) {
            const srvChanPair = context.rooms.remote.roomId.substr("_discord".length).split("_", ROOM_NAME_PARTS);
            return this.discord.ProcessMatrixMsgEvent(event, srvChanPair[0], srvChanPair[1]).catch((err) => {
                log.warn("There was an error sending a matrix event", err);
            });
        } else {
            // Might be a DM room.
            return this.discord.DMHandler.OnMatrixMessage(event);
        }
    } else if (event.type === "m.room.encryption" && context.rooms.remote) {
        return this.HandleEncryptionWarning(event.room_id).catch((err) => {
            return Promise.reject(`Failed to handle encrypted room, ${err}`);
        });
    } else {
      log.verbose("Got non m.room.message event");
    }
    return Promise.reject("Event not processed by bridge");
  }

  public async HandleEncryptionWarning(roomId: string): Promise<void> {
      const intent = this.bridge.getIntent();
      log.info(`User has turned on encryption in ${roomId}, so leaving.`);
      /* N.B 'status' is not specced but https://github.com/matrix-org/matrix-doc/pull/828
       has been open for over a year with no resolution. */
      const sendPromise = intent.sendMessage(roomId, {
          msgtype: "m.notice",
          status: "critical",
          body: "You have turned on encryption in this room, so the service will not bridge any new messages.",
      });
      const channel = await this.discord.GetChannelFromRoomId(roomId);
      await (channel as Discord.TextChannel).send(
        "Someone on Matrix has turned on encryption in this room, so the service will not bridge any new messages",
      );
      await sendPromise;
      await intent.leave(roomId);
      await this.bridge.getRoomStore().removeEntriesByMatrixRoomId(roomId);
  }

  public HandleInvite(event: any): Promise<any> {
    log.info("Received invite for " + event.state_key + " in room " + event.room_id);
    if (event.state_key === this.botUserId) {
      log.info("Accepting invite for bridge bot");
      return this.joinRoom(this.bridge.getIntent(), event.room_id);
    } else if (this.bridge.getBot().isRemoteUser(event.state_key)) {
      return this.discord.DMHandler.HandleInvite(event);
    } else {
      return this.discord.ProcessMatrixStateEvent(event);
    }
  }

  public async ProcessCommand(event: any, context: any) {
      if (!this.config.bridge.enableSelfServiceBridging) {
          // We can do this here because the only commands we support are self-service bridging
          return this.bridge.getIntent().sendMessage(event.room_id, {
              msgtype: "m.notice",
              body: "The owner of this bridge does not permit self-service bridging.",
          });
      }

      // Check to make sure the user has permission to do anything in the room. We can do this here
      // because the only commands we support are self-service commands (which therefore require some
      // level of permissions)
      const plEvent = await this.bridge.getIntent().getClient().getStateEvent(event.room_id, "m.room.power_levels", "");
      let userLevel = PROVISIONING_DEFAULT_USER_POWER_LEVEL;
      let requiredLevel = PROVISIONING_DEFAULT_POWER_LEVEL;
      if (plEvent && plEvent.state_default) {
          requiredLevel = plEvent.state_default;
      }
      if (plEvent && plEvent.users_default) {
          userLevel = plEvent.users_default;
      }
      if (plEvent && plEvent.users && plEvent.users[event.sender]) {
          userLevel = plEvent.users[event.sender];
      }

      if (userLevel < requiredLevel) {
          return this.bridge.getIntent().sendMessage(event.room_id, {
              msgtype: "m.notice",
              body: "You do not have the required power level in this room to create a bridge to a Discord channel.",
          });
      }

      const {command, args} = Util.MsgToArgs(event.content.body, "!discord");

      if (command === "help" && args[0] === "bridge") {
          const link = Util.GetBotLink(this.config);
          return this.bridge.getIntent().sendMessage(event.room_id, {
              msgtype: "m.notice",
              body: "How to bridge a Discord guild:\n" +
              "1. Invite the bot to your Discord guild using this link: " + link + "\n" +
              "2. Invite me to the matrix room you'd like to bridge\n" +
              "3. Open the Discord channel you'd like to bridge in a web browser\n" +
              "4. In the matrix room, send the message `!discord bridge <guild id> <channel id>` " +
              "(without the backticks)\n" +
              "   Note: The Guild ID and Channel ID can be retrieved from the URL in your web browser.\n" +
              "   The URL is formatted as https://discordapp.com/channels/GUILD_ID/CHANNEL_ID\n" +
              "5. Enjoy your new bridge!",
          });
      } else if (command === "bridge") {
          if (context.rooms.remote) {
              return this.bridge.getIntent().sendMessage(event.room_id, {
                  msgtype: "m.notice",
                  body: "This room is already bridged to a Discord guild.",
              });
          }

          const minArgs = 2;
          if (args.length < minArgs) {
              return this.bridge.getIntent().sendMessage(event.room_id, {
                  msgtype: "m.notice",
                  body: "Invalid syntax. For more information try !discord help bridge",
              });
          }

          const guildId = args[0];
          const channelId = args[1];
          try {
              const discordResult = await this.discord.LookupRoom(guildId, channelId);
              const channel = <Discord.TextChannel> discordResult.channel;

              log.info(`Bridging matrix room ${event.room_id} to ${guildId}/${channelId}`);
              this.bridge.getIntent().sendMessage(event.room_id, {
                  msgtype: "m.notice",
                  body: "I'm asking permission from the guild administrators to make this bridge.",
              });

              await this.provisioner.AskBridgePermission(channel, event.sender);
              this.provisioner.BridgeMatrixRoom(channel, event.room_id);
              return this.bridge.getIntent().sendMessage(event.room_id, {
                  msgtype: "m.notice",
                  body: "I have bridged this room to your channel",
              });
          } catch (err) {
              if (err.message === "Timed out waiting for a response from the Discord owners"
                  || err.message === "The bridge has been declined by the Discord guild") {
                  return this.bridge.getIntent().sendMessage(event.room_id, {
                      msgtype: "m.notice",
                      body: err.message,
                  });
              }

              log.error(`Error bridging ${event.room_id} to ${guildId}/${channelId}`);
              log.error(err);
              return this.bridge.getIntent().sendMessage(event.room_id, {
                  msgtype: "m.notice",
                  body: "There was a problem bridging that channel - has the guild owner approved the bridge?",
              });
          }
      } else if (command === "unbridge") {
          const remoteRoom = context.rooms.remote;

          if (!remoteRoom) {
              return this.bridge.getIntent().sendMessage(event.room_id, {
                  msgtype: "m.notice",
                  body: "This room is not bridged.",
              });
          }

          if (!remoteRoom.data.plumbed) {
              return this.bridge.getIntent().sendMessage(event.room_id, {
                  msgtype: "m.notice",
                  body: "This room cannot be unbridged.",
              });
          }

          try {
              await this.provisioner.UnbridgeRoom(remoteRoom);
              return this.bridge.getIntent().sendMessage(event.room_id, {
                  msgtype: "m.notice",
                  body: "This room has been unbridged",
              });
          } catch (err) {
              log.error("Error while unbridging room " + event.room_id);
              log.error(err);
              return this.bridge.getIntent().sendMessage(event.room_id, {
                  msgtype: "m.notice",
                  body: "There was an error unbridging this room. " +
                    "Please try again later or contact the bridge operator.",
              });
          }
      } else if (command === "help") {
          // Unknown command or no command given to get help on, so we'll just give them the help
          return this.bridge.getIntent().sendMessage(event.room_id, {
              msgtype: "m.notice",
              body: "Available commands:\n" +
              "!discord bridge <guild id> <channel id>   - Bridges this room to a Discord channel\n" +
              "!discord unbridge                         - Unbridges a Discord channel from this room\n" +
              "!discord help <command>                   - Help menu for another command. Eg: !discord help bridge\n",
          });
      }
  }

  public OnAliasQuery (alias: string, aliasLocalpart: string): Promise<any> {
    log.info("Got request for #", aliasLocalpart);
    const srvChanPair = aliasLocalpart.substr("_discord_".length).split("_", ROOM_NAME_PARTS);
    if (srvChanPair.length < ROOM_NAME_PARTS || srvChanPair[0] === "" || srvChanPair[1] === "") {
      log.warn(`Alias '${aliasLocalpart}' was missing a server and/or a channel`);
      return;
    }
    return this.discord.LookupRoom(srvChanPair[0], srvChanPair[1]).then((result) => {
      log.info("Creating #", aliasLocalpart);
      return this.createMatrixRoom(result.channel, aliasLocalpart);
    }).catch((err) => {
      log.error(`Couldn't find discord room '${aliasLocalpart}'.`, err);
    });
  }

  public tpGetProtocol(protocol: string): Promise<thirdPartyProtocolResult> {
    return Promise.resolve({
      user_fields: ["username", "discriminator"],
      location_fields: ["guild_id", "channel_name"],
      field_types: {
        // guild_name: {
        //   regexp: "\S.{0,98}\S",
        //   placeholder: "Guild",
        // },
        guild_id: {
          regexp: "[0-9]*",
          placeholder: "",
        },
        channel_id: {
          regexp: "[0-9]*",
          placeholder: "",
        },
        channel_name: {
           regexp: "[A-Za-z0-9_\-]{2,100}",
           placeholder: "#Channel",
        },
        username: {
          regexp: "[A-Za-z0-9_\-]{2,100}",
          placeholder: "Username",
        },
        discriminator: {
          regexp: "[0-9]{4}",
          placeholder: "1234",
        },
      },
      instances: this.discord.GetGuilds().map((guild) => {
        return {
          network_id: guild.id,
          bot_user_id: this.botUserId,
          desc: guild.name,
          icon: guild.iconURL || ICON_URL, // TODO: Use icons from our content repo. Potential security risk.
          fields: {
            guild_id: guild.id,
          },
        };
      }),
    });
  }

  public tpGetLocation(protocol: string, fields: any): Promise<thirdPartyLocationResult[]> {
    log.info("Got location request ", protocol, fields);
    const chans = this.discord.ThirdpartySearchForChannels(fields.guild_id, fields.channel_name);
    return Promise.resolve(chans);
  }

  public tpParseLocation(alias: string): Promise<thirdPartyLocationResult[]>  {
    return Promise.reject({err: "Unsupported", code: HTTP_UNSUPPORTED});
  }

  public tpGetUser(protocol: string, fields: any): Promise<thirdPartyUserResult[]> {
    log.info("Got user request ", protocol, fields);
    return Promise.reject({err: "Unsupported", code: HTTP_UNSUPPORTED});
  }

  public tpParseUser(userid: string): Promise<thirdPartyUserResult[]> {
    return Promise.reject({err: "Unsupported", code: HTTP_UNSUPPORTED});
  }

  public async HandleDiscordCommand(msg: Discord.Message) {
    if (!(<Discord.TextChannel> msg.channel).guild) {
      msg.channel.send("**ERROR:** only available for guild channels");
    }

    const {command, args} = Util.MsgToArgs(msg.content, "!matrix");

    const intent = this.bridge.getIntent();

    const actions: ICommandActions = {
      kick: {
        params: ["name"],
        description: "Kicks a user on the matrix side",
        permission: "KICK_MEMBERS",
        run: this.DiscordModerationActionGenerator(msg.channel as Discord.TextChannel, "kick", "Kicked"),
      },
      ban: {
        params: ["name"],
        description: "Bans a user on the matrix side",
        permission: "BAN_MEMBERS",
        run: this.DiscordModerationActionGenerator(msg.channel as Discord.TextChannel, "ban", "Banned"),
      },
      unban: {
        params: ["name"],
        description: "Unbans a user on the matrix side",
        permission: "BAN_MEMBERS",
        run: this.DiscordModerationActionGenerator(msg.channel as Discord.TextChannel, "unban", "Unbanned"),
      },
    };

    const parameters: ICommandParameters = {
      name: {
        description: "The display name or mxid of a matrix user",
        get: async (name) => {
          const channelMxids = await this.discord.ChannelSyncroniser.GetRoomIdsFromChannel(msg.channel);
          const mxUserId = await Util.GetMxidFromName(intent, name, channelMxids);
          return mxUserId;
        },
      },
    };

    if (command === "help") {
      let replyMessage = "Available Commands:\n";
      for (const actionKey of Object.keys(actions)) {
        const action = actions[actionKey];
        if (!msg.member.hasPermission(action.permission as any)) {
          continue;
        }
        replyMessage += " - `!matrix " + actionKey;
        for (const param of action.params) {
          replyMessage += ` <${param}>`;
        }
        replyMessage += "`: " + action.description + "\n";
      }
      replyMessage += "\nParameters:\n";
      for (const parameterKey of Object.keys(parameters)) {
        const parameter = parameters[parameterKey];
        replyMessage += " - `<" + parameterKey + ">`: " + parameter.description + "\n";
      }
      msg.channel.send(replyMessage);
      return;
    }

    if (!actions[command]) {
      msg.channel.send("**Error:** unknown command. Try `!matrix help` to see all commands");
      return;
    }

    if (!msg.member.hasPermission(actions[command].permission as any)) {
      msg.channel.send("**ERROR:** insufficiant permissions to use this matrix command");
      return;
    }

    let replyMessage = "";
    try {
      replyMessage = await Util.ParseCommand(actions[command], parameters, args);
    } catch (e) {
      replyMessage = "**ERROR:** " + e.message;
    }

    msg.channel.send(replyMessage);
  }

  private DiscordModerationActionGenerator(discordChannel: Discord.TextChannel, funcKey: string, action: string) {
    return async ({name}) => {
      let allChannelMxids = [];
      await Promise.all(discordChannel.guild.channels.map((chan) => {
        return this.discord.ChannelSyncroniser.GetRoomIdsFromChannel(chan).then((chanMxids) => {
          allChannelMxids = allChannelMxids.concat(chanMxids);
        }).catch((e) => {
          // pass, non-text-channel
        });
      }));
      let errorMsg = "";
      await Promise.all(allChannelMxids.map((chanMxid) => {
        const intent = this.bridge.getIntent();
        return intent[funcKey](chanMxid, name).catch((e) => {
          // maybe we don't have permission to kick/ban/unban...?
          errorMsg += `\nCouldn't ${funcKey} ${name} from ${chanMxid}`;
        });
      }));
      if (errorMsg) {
        throw Error(errorMsg);
      }
      return `${action} ${name}`;
    };
  }

  private joinRoom(intent: any, roomIdOrAlias: string): Promise<string> {
      let currentSchedule = JOIN_ROOM_SCHEDULE[0];
      const doJoin = () => Util.DelayedPromise(currentSchedule).then(() => intent.getClient().joinRoom(roomIdOrAlias));
      const errorHandler = (err) => {
          log.error(`Error joining room ${roomIdOrAlias} as ${intent.getClient().getUserId()}`);
          log.error(err);
          const idx = JOIN_ROOM_SCHEDULE.indexOf(currentSchedule);
          if (idx === JOIN_ROOM_SCHEDULE.length - 1) {
              log.warn(`Cannot join ${roomIdOrAlias} as ${intent.getClient().getUserId()}`);
              return Promise.reject(err);
          } else {
              currentSchedule = JOIN_ROOM_SCHEDULE[idx + 1];
              return doJoin().catch(errorHandler);
          }
      };

      return doJoin().catch(errorHandler);
  }

  private createMatrixRoom (channel: Discord.TextChannel, alias: string) {
    const remote = new RemoteRoom(`discord_${channel.guild.id}_${channel.id}`);
    remote.set("discord_type", "text");
    remote.set("discord_guild", channel.guild.id);
    remote.set("discord_channel", channel.id);
    remote.set("update_name", true);
    remote.set("update_topic", true);
    remote.set("update_icon", true);
    const creationOpts = {
      visibility: this.config.room.defaultVisibility,
      room_alias_name: alias,
      initial_state: [
        {
          type: "m.room.join_rules",
          content: {
            join_rule: "public",
          },
          state_key: "",
        },
      ],
    };
    return {
      creationOpts,
      remote,
    };
  }
}
