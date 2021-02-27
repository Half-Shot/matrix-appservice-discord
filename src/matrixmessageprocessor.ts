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
import { IMatrixMessage } from "./matrixtypes";
import { Util } from "./util";
import { DiscordBot } from "./bot";
import { MatrixClient } from "matrix-bot-sdk";
import { DiscordBridgeConfig } from "./config";
import {
    IMatrixMessageParserCallbacks,
    IMatrixMessageParserOpts,
    MatrixMessageParser,
} from "matrix-discord-parser";

const DEFAULT_ROOM_NOTIFY_POWER_LEVEL = 50;

export interface IMatrixMessageProcessorParams {
    displayname?: string;
    mxClient?: MatrixClient;
    roomId?: string;
    userId?: string;
}

export class MatrixMessageProcessor {
    private parser: MatrixMessageParser;
    constructor(public bot: DiscordBot, private config: DiscordBridgeConfig) {
        this.parser = new MatrixMessageParser();
    }

    public async FormatMessage(
        msg: IMatrixMessage,
        guild: Discord.Guild,
        params?: IMatrixMessageProcessorParams,
    ): Promise<string> {
        const opts = this.getParserOpts(msg, guild, params);
        return this.parser.FormatMessage(opts, msg);
    }

    private getParserOpts(
        msg: IMatrixMessage,
        guild: Discord.Guild,
        params?: IMatrixMessageProcessorParams,
    ): IMatrixMessageParserOpts {
        return {
            callbacks: this.getParserCallbacks(msg, guild, params),
            determineCodeLanguage: this.config.bridge.determineCodeLanguage,
            displayname: params ? params.displayname || "" : "",
        };
    }

    private getParserCallbacks(
        msg: IMatrixMessage,
        guild: Discord.Guild,
        params?: IMatrixMessageProcessorParams,
    ): IMatrixMessageParserCallbacks {
        return {
            canNotifyRoom: async () => {
                if (!params || !params.mxClient || !params.roomId || !params.userId) {
                    return false;
                }
                return await Util.CheckMatrixPermission(
                    params.mxClient,
                    params.userId,
                    params.roomId,
                    DEFAULT_ROOM_NOTIFY_POWER_LEVEL,
                    "notifications",
                    "room",
                );
            },
            getChannelId: async (mxid: string) => {
                const CHANNEL_REGEX = /^#_discord_[0-9]*_([0-9]*):/;
                const match = mxid.match(CHANNEL_REGEX);
                const channel = match && guild.channels.resolve(match[1]);
                if (!channel) {
                    /*
                    This isn't formatted in #_discord_, so let's fetch the internal room ID
                    and see if it is still a bridged room!
                    */
                    if (params && params.mxClient) {
                        try {
                            const resp = await params.mxClient.lookupRoomAlias(mxid);
                            if (resp && resp.roomId) {
                                const roomId = resp.roomId;
                                const ch = await this.bot.GetChannelFromRoomId(roomId);
                                return ch.id;
                            }
                        } catch (err) { } // ignore, room ID wasn't found
                    }
                    return null;
                }
                return match && match[1] || null;
            },
            getEmoji: async (mxc: string, name: string) => {
                let emoji: {id: string, animated: boolean, name: string} | null = null;
                try {
                    const emojiDb = await this.bot.GetEmojiByMxc(mxc);
                    const id = emojiDb.EmojiId;
                    emoji = guild.emojis.resolve(id);
                } catch (e) {
                    emoji = null;
                }
                if (!emoji) {
                    emoji = guild.emojis.resolve(name);
                }
                return emoji;
            },
            getUserId: async (mxid: string) => {
                const USER_REGEX = /^@_discord_([0-9]*)/;
                const match = mxid.match(USER_REGEX);
                const member = match && await guild.members.fetch(match[1]);
                if (!match || !member) {
                    return null;
                }
                return match[1];
            },
            mxcUrlToHttp: (mxc: string) => {
                if (params && params.mxClient) {
                    return params.mxClient.mxcToHttp(mxc);
                }
                return mxc;
            },
        };
    }
}
