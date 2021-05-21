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

import { expect } from "chai";
import { MockGuild } from "./mocks/guild";
import { MockMember } from "./mocks/member";
import { MockChannel } from "./mocks/channel";
import { MockEmoji } from "./mocks/emoji";
import { DbEmoji } from "../src/db/dbdataemoji";
import { MatrixMessageProcessor } from "../src/matrixmessageprocessor";

const bot = {
    GetChannelFromRoomId: async (roomId: string): Promise<MockChannel> => {
        if (roomId !== "!bridged:localhost") {
            throw new Error("Not bridged");
        }
        return new MockChannel("1234");
    },
    GetEmojiByMxc: async (mxc: string): Promise<DbEmoji> => {
        if (mxc === "mxc://real_emote:localhost") {
            const emoji = new DbEmoji();
            emoji.Name = "real_emote";
            emoji.EmojiId = "123456";
            emoji.Animated = false;
            emoji.MxcUrl = mxc;
            return emoji;
        }
        throw new Error("Couldn't fetch from store");
    },
} as any;

const config = {
    bridge: {
        determineCodeLanguage: false,
    },
} as any;

function getPlainMessage(msg: string, msgtype: string = "m.text") {
    return {
        body: msg,
        msgtype,
    };
}

function getHtmlMessage(msg: string, msgtype: string = "m.text") {
    return {
        body: msg,
        formatted_body: msg,
        msgtype,
    };
}

describe("MatrixMessageProcessor", () => {
    describe("FormatMessage / body / simple", () => {
        it("leaves blank stuff untouched", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getPlainMessage("hello world!");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("hello world!");
        });
        it("escapes simple stuff", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getPlainMessage("hello *world* how __are__ you?");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("hello \\*world\\* how \\_\\_are\\_\\_ you?");
        });
        it("escapes more complex stuff", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getPlainMessage("wow \\*this\\* is cool");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("wow \\\\\\*this\\\\\\* is cool");
        });
        it("escapes ALL the stuff", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getPlainMessage("\\ * _ ~ ` |");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("\\\\ \\* \\_ \\~ \\` \\|");
        });
    });
    describe("FormatMessage / formatted_body / simple", () => {
        it("leaves blank stuff untouched", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getHtmlMessage("hello world!");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("hello world!");
        });
        it("un-escapes simple stuff", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getHtmlMessage("foxes &amp; foxes");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("foxes & foxes");
        });
        it("converts italic formatting", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getHtmlMessage("this text is <em>italic</em> and so is <i>this one</i>");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("this text is *italic* and so is *this one*");
        });
        it("converts bold formatting", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getHtmlMessage("wow some <b>bold</b> and <strong>more</strong> boldness!");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("wow some **bold** and **more** boldness!");
        });
        it("converts underline formatting", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getHtmlMessage("to be <u>underlined</u> or not to be?");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("to be __underlined__ or not to be?");
        });
        it("converts strike formatting", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getHtmlMessage("does <del>this text</del> exist?");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("does ~~this text~~ exist?");
        });
        it("converts code", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getHtmlMessage("WOW this is <code>some awesome</code> code");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("WOW this is `some awesome` code");
        });
        it("converts multiline-code", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getHtmlMessage("<p>here</p><pre><code>is\ncode\n</code></pre><p>yay</p>");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("here```\nis\ncode\n```yay");
        });
    });
    describe("FormatMessage / formatted_body / discord", () => {
        it("Parses user pills", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const member = new MockMember("12345", "TestUsername", guild);
            guild.members.cache.set("12345", member);
            const msg = getHtmlMessage("<a href=\"https://matrix.to/#/@_discord_12345:localhost\">TestUsername</a>");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("<@12345>");
        });
        it("Ignores invalid user pills", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const member = new MockMember("12345", "TestUsername", guild);
            guild.members.cache.set("12345", member);
            const msg = getHtmlMessage("<a href=\"https://matrix.to/#/@_discord_789:localhost\">TestUsername</a>");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("[TestUsername](https://matrix.to/#/@_discord_789:localhost)");
        });
        it("Parses channel pills", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const channel = new MockChannel("12345", guild, "text", "SomeChannel");
            guild.channels.cache.set("12345", channel as any);
            const msg = getHtmlMessage("<a href=\"https://matrix.to/#/#_discord_1234_12345:" +
                "localhost\">#SomeChannel</a>");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("<#12345>");
        });
        it("Handles invalid channel pills", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const channel = new MockChannel("12345", guild, "text", "SomeChannel");
            guild.channels.cache.set("12345", channel as any);
            const msg = getHtmlMessage("<a href=\"https://matrix.to/#/#_discord_1234_789:localhost\">#SomeChannel</a>");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("[#SomeChannel](https://matrix.to/#/#_discord_1234_789:localhost)");
        });
        it("Handles external channel pills", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getHtmlMessage("<a href=\"https://matrix.to/#/#matrix:matrix.org\">#SomeChannel</a>");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("[#SomeChannel](https://matrix.to/#/#matrix:matrix.org)");
        });
        it("Handles external channel pills of rooms that are actually bridged", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getHtmlMessage("<a href=\"https://matrix.to/#/#matrix:matrix.org\">#SomeChannel</a>");

            const result = await mp.FormatMessage(msg, guild as any, {
                mxClient: {
                    lookupRoomAlias: async () => ({
                        residentServers: [],
                        roomId: "!bridged:localhost",
                    }),
                } as any,
            });
            expect(result).is.equal("<#1234>");
        });
        it("Ignores links without href", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getHtmlMessage("<a><em>yay?</em></a>");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("*yay?*");
        });
        it("Ignores links with non-matrix href", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getHtmlMessage("<a href=\"http://example.com\"><em>yay?</em></a>");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("[*yay?*](http://example.com)");
        });
        it("Handles spoilers", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getHtmlMessage("<span data-mx-spoiler>foxies</span>");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("||foxies||");
        });
        it("Handles spoilers with reason", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getHtmlMessage("<span data-mx-spoiler=\"floof\">foxies</span>");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("(floof)||foxies||");
        });
    });
    describe("FormatMessage / formatted_body / emoji", () => {
        it("Inserts emoji by name", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const emoji = new MockEmoji("123456", "test_emoji");
            guild.emojis.cache.set("123456", emoji);
            const msg = getHtmlMessage("<img alt=\"test_emoji\">");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("test\\_emoji");
        });
        it("Inserts emojis by mxc url", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const emoji = new MockEmoji("123456", "test_emoji");
            guild.emojis.cache.set("123456", emoji);
            const msg = getHtmlMessage("<img src=\"mxc://real_emote:localhost\">");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("<:test_emoji:123456>");
        });
        it("parses unknown mxc urls", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const emoji = new MockEmoji("123456", "test_emoji");
            guild.emojis.cache.set("123456", emoji);
            const msg = getHtmlMessage("<img alt=\"yay\" src=\"mxc://unreal_emote:localhost\">");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("[yay mxc://unreal_emote:localhost ]");
        });
        it("ignores with no alt / title, too", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const emoji = new MockEmoji("123456", "test_emoji");
            guild.emojis.cache.set("123456", emoji);
            const msg = getHtmlMessage("<img>");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("");
        });
    });
    describe("FormatMessage / formatted_body / matrix", () => {
        /**
         * Returns a mocked matrix client that mocks the m.room.power_levels
         * event to test @room notifications.
         *
         * @param roomNotificationLevel the power level required to @room
         * (if undefined, does not include notifications.room in
         * m.room.power_levels)
         */
        function getMxClient(roomNotificationLevel?: number) {
            return {
                getRoomStateEvent: async (roomId, stateType, _) => {
                    if (stateType === "m.room.power_levels") {
                        return {
                            // Only include notifications.room when
                            // roomNotificationLevel is undefined
                            ...roomNotificationLevel !== undefined && {
                                notifications: {
                                    room: roomNotificationLevel,
                                },
                            },
                            users: {
                                "@nopower:localhost": 0,
                                "@power:localhost": 100,
                            },
                        };
                    }
                    return null;
                },
            };
        }

        /**
         * Explicit power level required to notify @room.
         *
         * Essentially, we want to test two code paths - one where the explicit
         * power level is set and one where it isn't, to see if the bridge can
         * fall back to a default level (of 50). This is the explicit value we
         * will set.
         */
        const ROOM_NOTIFICATION_LEVEL = 50;

        it("escapes @everyone", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getPlainMessage("hey @everyone");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("hey @\u200Beveryone");
        });
        it("escapes @here", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getPlainMessage("hey @here");
            const result = await mp.FormatMessage(msg, guild as any);
            expect(result).is.equal("hey @\u200Bhere");
        });
        it("converts @room to @here, if sufficient power", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getPlainMessage("hey @room");
            let params = {
                mxClient: getMxClient(ROOM_NOTIFICATION_LEVEL),
                roomId: "!123456:localhost",
                userId: "@power:localhost",
            };
            let result = await mp.FormatMessage(msg, guild as any, params as any);
            expect(result).is.equal("hey @here");

            // Test again using an unset notifications.room value in
            // m.room.power_levels, to ensure it falls back to a default
            // requirement.
            params = {
                mxClient: getMxClient(),
                roomId: "!123456:localhost",
                userId: "@power:localhost",
            };
            result = await mp.FormatMessage(msg, guild as any, params as any);
            expect(result).is.equal("hey @here");
        });
        it("ignores @room to @here conversion, if insufficient power", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getPlainMessage("hey @room");
            let params = {
                mxClient: getMxClient(ROOM_NOTIFICATION_LEVEL),
                roomId: "!123456:localhost",
                userId: "@nopower:localhost",
            };
            let result = await mp.FormatMessage(msg, guild as any, params as any);
            expect(result).is.equal("hey @room");

            // Test again using an unset notifications.room value in
            // m.room.power_levels, to ensure it falls back to a default
            // requirement.
            params = {
                mxClient: getMxClient(),
                roomId: "!123456:localhost",
                userId: "@nopower:localhost",
            };
            result = await mp.FormatMessage(msg, guild as any, params as any);
            expect(result).is.equal("hey @room");
        });
        it("handles /me for normal names", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getPlainMessage("floofs", "m.emote");
            const params = {
                displayname: "fox",
            };
            const result = await mp.FormatMessage(msg, guild as any, params as any);
            expect(result).is.equal("_fox floofs_");
        });
        it("handles /me for short names", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getPlainMessage("floofs", "m.emote");
            const params = {
                displayname: "f",
            };
            const result = await mp.FormatMessage(msg, guild as any, params as any);
            expect(result).is.equal("_floofs_");
        });
        it("handles /me for long names", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getPlainMessage("floofs", "m.emote");
            const params = {
                displayname: "foxfoxfoxfoxfoxfoxfoxfoxfoxfoxfoxfox",
            };
            const result = await mp.FormatMessage(msg, guild as any, params as any);
            expect(result).is.equal("_floofs_");
        });
        it("discord escapes nicks in /me", async () => {
            const mp = new MatrixMessageProcessor(bot, config);
            const guild = new MockGuild("1234");
            const msg = getPlainMessage("floofs", "m.emote");
            const params = {
                displayname: "fox_floof",
            };
            const result = await mp.FormatMessage(msg, guild as any, params as any);
            expect(result).is.equal("_fox\\_floof floofs_");
        });
    });
});
