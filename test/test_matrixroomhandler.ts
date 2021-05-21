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
import * as Proxyquire from "proxyquire";
import { DiscordBridgeConfig } from "../src/config";
import { MockChannel } from "./mocks/channel";
import { MockMember } from "./mocks/member";
import { MockGuild } from "./mocks/guild";
import { Util } from "../src/util";
import { AppserviceMock } from "./mocks/appservicemock";

const MatrixRoomHandler = (Proxyquire("../src/matrixroomhandler", {
    "./util": {
        Util: {
            DelayedPromise: Util.DelayedPromise,
            GetMxidFromName: () => {
                return "@123456:localhost";
            },
            MsgToArgs: Util.MsgToArgs,
            ParseCommand: Util.ParseCommand,
        },
    },
})).MatrixRoomHandler;

let USERSJOINED = 0;

function createRH(opts: any = {}) {
    USERSJOINED = 0;
    const bridge = new AppserviceMock({
        joinedrooms: ["!123:localhost"],
        userIdPrefix: "@_discord_",
    });
    const us = {
        JoinRoom: async () => { USERSJOINED++; },
        OnUpdateUser: async () => { },
    };
    const cs = {
        GetRoomIdsFromChannel: async (chan) => {
            return [`#${chan.id}:localhost`];
        },
        OnUpdate: async () => { },
    };
    const bot = {
        BotUserId: "@botuser:localhost",
        ChannelSyncroniser: cs,
        GetBotId: () => "bot12345",
        GetChannelFromRoomId: async (roomid: string) => {
            if (roomid === "!accept:localhost") {
                const guild = new MockGuild("666666");
                const chan = new MockChannel("777777", guild);
                if (opts.createMembers) {
                    chan.members.set("12345", new MockMember("12345", "testuser1"));
                    chan.members.set("54321", new MockMember("54321", "testuser2"));
                    chan.members.set("bot12345", new MockMember("bot12345", "botuser"));
                }
                guild.members.updateCache(chan.members);
                return chan;
            } else {
                throw new Error("Roomid not found");
            }
        },
        GetGuilds: () => [new MockGuild("123", [])],
        GetIntentFromDiscordMember: (member: {id: string}) => {
            return bridge.getIntentForSuffix(member.id);
        },
        HandleMatrixKickBan: async () => {

        },
        LookupRoom: async (guildid, discordid) => {
            if (guildid !== "123") {
                throw new Error("Guild not found");
            } else if (discordid !== "456") {
                throw new Error("Channel not found");
            }
            const channel = new MockChannel(discordid, new MockGuild(guildid));
            return {channel, botUser: true };
        },
        ThirdpartySearchForChannels: () => {
            return [];
        },
        UserSyncroniser: us,
    };
    const config = new DiscordBridgeConfig();
    config.room.defaultVisibility = "public";
    config.limits.roomGhostJoinDelay = 0;
    if (opts.disableSS) {
        config.bridge.enableSelfServiceBridging = false;
    } else {
        config.bridge.enableSelfServiceBridging = true;
    }
    const store = {
        getEntriesByMatrixId: (matrixId) => {
            return [{
                matrix: {},
                remote: {},
            }];
        },
        linkRooms: () => {

        },
        removeEntriesByMatrixRoomId: () => {

        },
    };
    const handler = new MatrixRoomHandler(bot as any, config, bridge as any, store);
    return { handler, bridge };
}

describe("MatrixRoomHandler", () => {
    describe("OnAliasQueried", () => {
        it("should join successfully", async () => {
            const {handler} = createRH();
            await handler.OnAliasQueried("#accept:localhost", "!accept:localhost");
        });
        it("should join successfully and create ghosts", async () => {
            const EXPECTEDUSERS = 2;
            const {handler} = createRH({createMembers: true});
            await handler.OnAliasQueried("#accept:localhost", "!accept:localhost");
            expect(USERSJOINED).to.equal(EXPECTEDUSERS);
        });
        it("should not join successfully", async () => {
            const {handler} = createRH();
            try {
                await handler.OnAliasQueried("#reject:localhost", "!reject:localhost");
                throw new Error("didn't fail");
            } catch (e) {
                expect(e.message).to.not.equal("didn't fail");
            }
        });
    });
    describe("OnAliasQuery", () => {
        it("will create room", async () => {
            const {handler} = createRH({});
            const ret = await handler.OnAliasQuery("#_discord_123_456:localhost");
            expect(ret).to.be.deep.equal({
                initial_state: [
                    {
                        content: {
                            join_rule: "public",
                        },
                        state_key: "",
                        type: "m.room.join_rules",
                    },
                ],
                room_alias_name: "_discord_123_456",
                visibility: "public",
            });
        });
        it("will not create room if guild cannot be found", async () => {
            const {handler} = createRH({});
            handler.createMatrixRoom = () => true;
            const ret = await handler.OnAliasQuery(
                "#_discord_111_456:localhost");
            expect(ret).to.be.undefined;
        });
        it("will not create room if channel cannot be found", async () => {
            const {handler} = createRH({});
            handler.createMatrixRoom = () => true;
            const ret = await handler.OnAliasQuery(
                "#_discord_123_444:localhost");
            expect(ret).to.be.undefined;
        });
        it("will not create room if alias is wrong", async () => {
            const {handler} = createRH({});
            handler.createMatrixRoom = () => true;
            const ret = await handler.OnAliasQuery(
                "#_discord_123:localhost");
            expect(ret).to.be.undefined;
        });
    });
    // Currently not supported on matrix-js-bot-sdk
    //
    // describe("tpGetProtocol", () => {
    //    it("will return an object", async () => {
    //        const {handler} = createRH({});
    //        const protocol = await handler.tpGetProtocol("");
    //        expect(protocol).to.not.be.null;
    //        expect(protocol.instances[0].network_id).to.equal("123");
    //        expect(protocol.instances[0].bot_user_id).to.equal("@botuser:localhost");
    //        expect(protocol.instances[0].desc).to.equal("123");
    //        expect(protocol.instances[0].network_id).to.equal("123");
    //    });
    // });
    // describe("tpGetLocation", () => {
    //     it("will return an array", async () => {
    //         const {handler} = createRH({});
    //         const channels = await handler.tpGetLocation("", {
    //             channel_name: "",
    //             guild_id: "",
    //         });
    //         expect(channels).to.be.a("array");
    //     });
    // });
    // describe("tpParseLocation", () => {
    //     it("will reject", async () => {
    //         const {handler} = createRH({});
    //         try {
    //             await handler.tpParseLocation("alias");
    //             throw new Error("didn't fail");
    //         } catch (e) {
    //             expect(e.message).to.not.equal("didn't fail");
    //         }
    //     });
    // });
    // describe("tpGetUser", () => {
    //     it("will reject", async () => {
    //         const {handler} = createRH({});
    //         try {
    //             await handler.tpGetUser("", {});
    //             throw new Error("didn't fail");
    //         } catch (e) {
    //             expect(e.message).to.not.equal("didn't fail");
    //         }
    //     });
    // });
    // describe("tpParseUser", () => {
    //     it("will reject", async () => {
    //         const {handler} = createRH({});
    //         try {
    //             await handler.tpParseUser("alias");
    //             throw new Error("didn't fail");
    //         } catch (e) {
    //             expect(e.message).to.not.equal("didn't fail");
    //         }
    //     });
    // });
    describe("joinRoom", () => {
        it("will join immediately", async () => {
            const {handler, bridge} = createRH({});
            const intent = bridge.botIntent;
            await handler.joinRoom(intent, "#test:localhost");
            intent.wasCalled("joinRoom", true, "#test:localhost");
        });
        it("will fail first, join after", async () => {
            const {handler, bridge} = createRH({});
            let shouldFail = true;
            const intent = {
                getUserId: () => "@test:localhost",
                joinRoom: async () => {
                    if (shouldFail) {
                        shouldFail = false;
                        throw new Error("Test failed first time");
                    }
                },
            };
            const startTime = Date.now();
            const MINTIME = 1000;
            await handler.joinRoom(intent, "#test:localhost");
            expect(shouldFail).to.be.false;
            expect(1).to.satisfy(() => {
                return (Date.now() - startTime) > MINTIME;
            });
        });
    });
    describe("createMatrixRoom", () => {
        it("will return an object", async () => {
            const {handler} = createRH({});
            const channel = new MockChannel("123", new MockGuild("456"));
            const roomOpts = await handler.createMatrixRoom(channel, "#test:localhost");
            expect(roomOpts).to.exist;
        });
    });
});
