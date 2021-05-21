/*
Copyright 2019 matrix-appservice-discord

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
import { Util } from "../src/util";
import { DiscordBridgeConfig } from "../src/config";
import { MockChannel } from "./mocks/channel";
import { AppserviceMock } from "./mocks/appservicemock";
import * as Proxyquire from "proxyquire";

function createCH(opts: any = {}, shouldBeJoined = true) {

    const bridge = new AppserviceMock({
        joinedrooms: shouldBeJoined ? ["!123:localhost"] : [],
    });

    const config = new DiscordBridgeConfig();
    config.limits.roomGhostJoinDelay = 0;
    if (opts.disableSS) {
        config.bridge.enableSelfServiceBridging = false;
    } else {
        config.bridge.enableSelfServiceBridging = true;
    }
    const provisioner = {
        AskBridgePermission: async () => {
            if (opts.denyBridgePermission) {
                throw new Error("The bridge has been declined by the Discord guild.");
            }
        },
        BridgeMatrixRoom: () => {
            if (opts.failBridgeMatrix) {
                throw new Error("Test failed matrix bridge");
            }
        },
        RoomCountLimitReached: async () => {
            return !!opts.roomCountLimitReached;
        },
        UnbridgeChannel: async () => {
            if (opts.failUnbridge) {
                throw new Error("Test failed unbridge");
            }
        },
    };
    const bot = {
        GetBotId: () => "@botuser:localhost",
        LookupRoom: async (guildid, discordid) => {
            if (guildid !== "123") {
                throw new Error("Guild not found");
            } else if (discordid !== "456") {
                throw new Error("Channel not found");
            }
            const channel = new MockChannel();
            return {channel, botUser: true };
        },
        Provisioner: provisioner,
    };

    const MatrixCommandHndl = (Proxyquire("../src/matrixcommandhandler", {
        "./util": {
            Util: {
                CheckMatrixPermission: async () => {
                    return opts.power !== undefined ? opts.power : true;
                },
                GetBotLink: Util.GetBotLink,
                ParseCommand: Util.ParseCommand,
            },
        },
    })).MatrixCommandHandler;
    return {handler: new MatrixCommandHndl(bot as any, bridge, config), bridge};
}

function createEvent(msg: string, room?: string, userId?: string) {
    return {
        content: {
            body: msg,
        },
        room_id: room ? room : "!123:localhost",
        sender: userId,
    };
}

function createContext(remoteData?: any) {
    return {
        remote: remoteData,
    };
}

describe("MatrixCommandHandler", () => {
    describe("Process", () => {
        it("should not process command if not in room", async () => {
            const {handler, bridge} = createCH({}, false);
            await handler.Process(createEvent("", "!666:localhost"), createContext());
            bridge.botIntent.wasNotCalled("sendText", true);
            bridge.botIntent.wasNotCalled("sendMessage", true);
        });
        it("should warn if self service is disabled", async () => {
            const {handler, bridge} = createCH({disableSS: true});
            await handler.Process(createEvent("!discord bridge"), createContext());
            bridge.botIntent.underlyingClient.wasCalled("sendMessage", true, "!123:localhost", {
                body: "**ERROR:** The owner of this bridge does not permit self-service bridging.",
                format: "org.matrix.custom.html",
                formatted_body: `<p><strong>ERROR:</strong> The owner of this bridge` +
` does not permit self-service bridging.</p>\n`,
                msgtype: "m.notice",
            });
        });
        it("should warn if user is not powerful enough", async () => {
            const {handler, bridge} = createCH({power: false});
            await handler.Process(createEvent("!discord bridge"), createContext());
            const expected = "**ERROR:** insufficient permissions to use this " +
            "command! Try `!discord help` to see all available commands";
            const htmlExpected = `<p><strong>ERROR:</strong> insufficient permissions to use this command!` +
` Try <code>!discord help</code> to see all available commands</p>\n`;
            bridge.botIntent.underlyingClient.wasCalled("sendMessage", true, "!123:localhost", {
                body: expected,
                format: "org.matrix.custom.html",
                formatted_body: htmlExpected,
                msgtype: "m.notice",
            });
        });
        describe("!discord bridge", () => {
            it("will bridge a new room, and ask for permissions", async () => {
                const {handler, bridge} = createCH();
                await handler.Process(createEvent("!discord bridge 123 456"), createContext());
                const expected = "I have bridged this room to your channel";
                const expectedHtml = "<p>I have bridged this room to your channel</p>\n";
                bridge.botIntent.underlyingClient.wasCalled("sendMessage", true, "!123:localhost", {
                    body: expected,
                    format: "org.matrix.custom.html",
                    formatted_body: expectedHtml,
                    msgtype: "m.notice",
                });
            });
            it("will fail to bridge if permissions were denied", async () => {
                const {handler, bridge} = createCH({
                    denyBridgePermission: true,
                });
                await handler.Process(createEvent("!discord bridge 123 456"), createContext());
                const expected = "The bridge has been declined by the Discord guild.";
                const expectedHtml = "<p>The bridge has been declined by the Discord guild.</p>\n";
                bridge.botIntent.underlyingClient.wasCalled("sendMessage", true, "!123:localhost", {
                    body: expected,
                    format: "org.matrix.custom.html",
                    formatted_body: expectedHtml,
                    msgtype: "m.notice",
                });
            });
            it("will fail to bridge if permissions were failed", async () => {
                const {handler, bridge} = createCH({
                    failBridgeMatrix: true,
                });
                await handler.Process(createEvent("!discord bridge 123 456"), createContext());
                const expected = "There was a problem bridging that channel - has the guild owner approved the bridge?";
                const expectedHtml = "<p>There was a problem bridging that channel - has the guild owner approved the bridge?</p>\n";
                bridge.botIntent.underlyingClient.wasCalled("sendMessage", true, "!123:localhost", {
                    body: expected,
                    format: "org.matrix.custom.html",
                    formatted_body: expectedHtml,
                    msgtype: "m.notice",
                });
            });
            it("will not bridge if a link already exists", async () => {
                const {handler, bridge} = createCH();
                await handler.Process(createEvent("!discord bridge 123 456"), createContext(true));
                const expected = "This room is already bridged to a Discord guild.";
                const expectedHtml = "<p>This room is already bridged to a Discord guild.</p>\n";
                bridge.botIntent.underlyingClient.wasCalled("sendMessage", true, "!123:localhost", {
                    body: expected,
                    format: "org.matrix.custom.html",
                    formatted_body: expectedHtml,
                    msgtype: "m.notice",
                });
            });
            it("will not bridge without required args", async () => {
                const {handler, bridge} = createCH();
                await handler.Process(createEvent("!discord bridge"), createContext());
                const expected = "Invalid syntax. For more information try `!discord help bridge`";
                const expectedHtml = "<p>Invalid syntax. For more information try <code>!discord help bridge</code></p>\n";
                bridge.botIntent.underlyingClient.wasCalled("sendMessage", true, "!123:localhost", {
                    body: expected,
                    format: "org.matrix.custom.html",
                    formatted_body: expectedHtml,
                    msgtype: "m.notice",
                });
            });
            it("will bridge with x/y syntax", async () => {
                const {handler, bridge} = createCH({powerLevels: {
                    users_default: 100,
                }});
                await handler.Process(createEvent("!discord bridge 123/456"), createContext());
                const expected = "I have bridged this room to your channel";
                const expectedHtml = "<p>I have bridged this room to your channel</p>\n";
                bridge.botIntent.underlyingClient.wasCalled("sendMessage", true, "!123:localhost", {
                    body: expected,
                    format: "org.matrix.custom.html",
                    formatted_body: expectedHtml,
                    msgtype: "m.notice",
                });
            });
        });
        describe("!discord unbridge", () => {
            it("will unbridge", async () => {
                const expected = "This room has been unbridged";
                const expectedHtml = "<p>This room has been unbridged</p>\n";
                const {handler, bridge} = createCH();
                await handler.Process(createEvent("!discord unbridge"), createContext(
                    {
                        data: {
                            discord_channel: "456",
                            discord_guild: "123",
                            plumbed: true,
                        },
                    },
                ));
                bridge.botIntent.underlyingClient.wasCalled("sendMessage", true, "!123:localhost", {
                    body: expected,
                    format: "org.matrix.custom.html",
                    formatted_body: expectedHtml,
                    msgtype: "m.notice",
                });
            });
            it("will not unbridge if a link does not exist", async () => {
                const expected = "This room is not bridged.";
                const expectedHtml = "<p>This room is not bridged.</p>\n";
                const {handler, bridge} = createCH();
                await handler.Process(createEvent("!discord unbridge"), createContext());
                bridge.botIntent.underlyingClient.wasCalled("sendMessage", true, "!123:localhost", {
                    body: expected,
                    format: "org.matrix.custom.html",
                    formatted_body: expectedHtml,
                    msgtype: "m.notice",
                });
            });
            it("will not unbridge non-plumbed rooms", async () => {
                const expected = "This room cannot be unbridged.";
                const expectedHtml = "<p>This room cannot be unbridged.</p>\n";
                const {handler, bridge} = createCH();
                await handler.Process(createEvent("!discord unbridge"), createContext(
                    {
                        data: {
                            discord_channel: "456",
                            discord_guild: "123",
                            plumbed: false,
                        },
                    },
                ));
                bridge.botIntent.underlyingClient.wasCalled("sendMessage", true, "!123:localhost", {
                    body: expected,
                    format: "org.matrix.custom.html",
                    formatted_body: expectedHtml,
                    msgtype: "m.notice",
                });
            });
            it("will show error if unbridge fails", async () => {
                const expected = "There was an error unbridging this room. Please " +
                "try again later or contact the bridge operator.";
                const expectedHtml = `<p>There was an error unbridging this room. Please` +
` try again later or contact the bridge operator.</p>\n`;
                const {handler, bridge} = createCH({
                    failUnbridge: true,
                });
                await handler.Process(createEvent("!discord unbridge"), createContext(
                    {
                        data: {
                            discord_channel: "456",
                            discord_guild: "123",
                            plumbed: true,
                        },
                    },
                ));
                bridge.botIntent.underlyingClient.wasCalled("sendMessage", true, "!123:localhost", {
                    body: expected,
                    format: "org.matrix.custom.html",
                    formatted_body: expectedHtml,
                    msgtype: "m.notice",
                });
            });
        });
    });
    describe("HandleInvite", () => {
        it("should accept invite for bot user", async () => {
            const { handler, bridge } = createCH();
            handler.joinRoom = async () => {
            };
            await handler.HandleInvite({
                state_key: "@botuser:localhost",
            });
            bridge.botIntent.wasCalled("joinRoom", true);
        });
        it("should deny invite for other users", async () => {
            const { handler, bridge } = createCH();
            let joinedRoom = false;
            handler.joinRoom = async () => {
                joinedRoom = true;
            };
            await handler.HandleInvite({
                state_key: "@user:localhost",
            });
            bridge.getIntent("@user:localhost").wasNotCalled("joinRoom", true);
            expect(joinedRoom).to.be.false;
        });
    });
});
