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

import { expect } from "chai";
import * as Proxyquire from "proxyquire";

import { MockGuild } from "./mocks/guild";
import { MockMember } from "./mocks/member";
import { MockDiscordClient } from "./mocks/discordclient";
import { MockMessage } from "./mocks/message";
import { Util } from "../src/util";
import { AppserviceMock } from "./mocks/appservicemock";
import { MockUser } from "./mocks/user";
import { MockTextChannel } from "./mocks/channel";

const mockBridge = new AppserviceMock({});

const modDiscordBot = Proxyquire("../src/bot", {
    "./clientfactory": require("./mocks/discordclientfactory"),
    "./util": {
        Util: {
            AsyncForEach: Util.AsyncForEach,
            DelayedPromise: Util.DelayedPromise,
            DownloadFile: async () => {
                return {buffer: Buffer.alloc(1000)};
            },
            UploadContentFromUrl: async () => {
                return {mxcUrl: "uploaded"};
            },
        },
    },
});
describe("DiscordBot", () => {
    let discordBot;
    const config = {
        auth: {
            botToken: "blah",
        },
        bridge: {
            disablePresence: true,
            domain: "localhost",
        },
        limits: {
            discordSendDelay: 50,
        },
    };
    describe("run()", () => {
        it("should resolve when ready.", async () => {
            discordBot = new modDiscordBot.DiscordBot(
                config,
                mockBridge,
                {},
            );
            await discordBot.run();
        });
    });

    describe("LookupRoom()", () => {
        beforeEach( async () => {
            discordBot = new modDiscordBot.DiscordBot(
                config,
                mockBridge,
                {},
            );
            await discordBot.run();
        });
        it("should reject a missing guild.", async () => {
            try {
                await discordBot.LookupRoom("541", "321");
                throw new Error("didn't fail");
            } catch (e) {
                expect(e.message).to.not.equal("didn't fail");
            }
        });

        it("should reject a missing channel.", async () => {
            try {
                await discordBot.LookupRoom("123", "666");
                throw new Error("didn't fail");
            } catch (e) {
                expect(e.message).to.not.equal("didn't fail");
            }
        });

        it("should resolve a guild and channel id.", async () => {
            await discordBot.LookupRoom("123", "321");
        });
    });
    describe("OnMessage()", () => {
        const channel = new MockTextChannel();
        const msg = new MockMessage(channel);
        const author = new MockUser("11111");
        let HANDLE_COMMAND = false;
        function getDiscordBot() {
            HANDLE_COMMAND = false;
            mockBridge.cleanup();
            const discord = new modDiscordBot.DiscordBot(
                config,
                mockBridge,
                {},
            );
            discord.bot = { user: { id: "654" } };
            discord.userSync = {
                OnUpdateUser: async () => { },
            };
            discord.channelSync = {
                GetRoomIdsFromChannel: async () => ["!asdf:localhost"],
            };
            discord.discordCommandHandler = {
                Process: async () => { HANDLE_COMMAND = true; },
            };
            discord.store = {
                Insert: async (_) => { },
            };
            return discord;
        }
        it("ignores own messages", async () => {
            discordBot = getDiscordBot();
            const guild: any = new MockGuild("123", []);
            const ownAuthor = new MockUser("654", "TestUsername");
            guild._mockAddMember(author);
            msg.author = ownAuthor;
            msg.content = "Hi!";
            await discordBot.OnMessage(msg);
            expect(mockBridge.getIntent(author.id).wasCalled("sendEvent", false)).to.equal(0);
        });
        it("Passes on !matrix commands", async () => {
            discordBot = getDiscordBot();
            msg.author = author;
            msg.content = "!matrix test";
            await discordBot.OnMessage(msg);
            expect(HANDLE_COMMAND).to.be.true;
        });
        it("skips empty messages", async () => {
            discordBot = getDiscordBot();
            msg.content = "";
            msg.author = author;
            await discordBot.OnMessage(msg as any);
            expect(mockBridge.getIntent(author.id).wasCalled("sendEvent", false)).to.equal(0);
        });
        it("sends normal messages", async () => {
            discordBot = getDiscordBot();
            msg.author = author;
            msg.content = "Foxies are amazing!";
            await discordBot.OnMessage(msg as any);
            mockBridge.getIntent(author.id).wasCalled("sendEvent");
        });
        it("sends edit messages", async () => {
            discordBot = getDiscordBot();
            msg.author = author;
            msg.content = "Foxies are super amazing!";
            await discordBot.OnMessage(msg, "editevent");
            mockBridge.getIntent(author.id).wasCalled("sendEvent", true,  "!asdf:localhost", {
                "body": "* Foxies are super amazing!",
                "format": "org.matrix.custom.html",
                "formatted_body": "* Foxies are super amazing!",
                "m.new_content": {
                    body: "Foxies are super amazing!",
                    format: "org.matrix.custom.html",
                    formatted_body: "Foxies are super amazing!",
                    msgtype: "m.text",
                },
                "m.relates_to": { event_id: "editevent", rel_type: "m.replace" },
                "msgtype": "m.text",
            });
        });
        it("uploads images", async () => {
            discordBot = getDiscordBot();
            msg.author = author;
            msg.attachments.set("1234", {
                name: "someimage.png",
                size: 42,
                height: 0,
                url: "asdf",
                width: 0,
            });
            await discordBot.OnMessage(msg);
            const intent = mockBridge.getIntent(author.id);
            intent.underlyingClient.wasCalled("uploadContent");
            intent.wasCalled("sendEvent", true, "!asdf:localhost", {
                body: "someimage.png",
                external_url: "asdf",
                info: {
                    h: 0,
                    mimetype: "image/png",
                    size: 42,
                    w: 0,
                },
                msgtype: "m.image",
                url: "mxc://someimage.png",
            });
        });
        it("uploads videos", async () => {
            discordBot = getDiscordBot();
            msg.author = author;
            msg.attachments.set("1234", {
                name: "foxes.mov",
                size: 42,
                height: 0,
                url: "asdf",
                width: 0,
            });
            await discordBot.OnMessage(msg);
            const intent = mockBridge.getIntent(author.id);
            intent.underlyingClient.wasCalled("uploadContent");
            intent.wasCalled("sendEvent", true, "!asdf:localhost", {
                body: "foxes.mov",
                external_url: "asdf",
                info: {
                    h: 0,
                    mimetype: "video/quicktime",
                    size: 42,
                    w: 0,
                },
                msgtype: "m.video",
                url: "mxc://foxes.mov",
            });
        });
        it("uploads audio", async () => {
            discordBot = getDiscordBot();
            msg.author = author;
            msg.attachments.set("1234", {
                name: "meow.mp3",
                size: 42,
                height: 0,
                url: "asdf",
                width: 0,
            });
            await discordBot.OnMessage(msg);
            const intent = mockBridge.getIntent(author.id);
            intent.underlyingClient.wasCalled("uploadContent");
            intent.wasCalled("sendEvent", true, "!asdf:localhost", {
                body: "meow.mp3",
                external_url: "asdf",
                info: {
                    mimetype: "audio/mpeg",
                    size: 42,
                },
                msgtype: "m.audio",
                url: "mxc://meow.mp3",
            });
        });
        it("uploads other files", async () => {
            discordBot = getDiscordBot();
            msg.author = author;
            msg.attachments.set("1234", {
                name: "meow.zip",
                size: 42,
                height: 0,
                url: "asdf",
                width: 0,
            });
            await discordBot.OnMessage(msg);
            const intent = mockBridge.getIntent(author.id);
            intent.underlyingClient.wasCalled("uploadContent");
            intent.wasCalled("sendEvent", true, "!asdf:localhost", {
                body: "meow.zip",
                external_url: "asdf",
                info: {
                    mimetype: "application/zip",
                    size: 42,
                },
                msgtype: "m.file",
                url: "mxc://meow.zip",
            });
        });
    });
    describe("OnMessageUpdate()", () => {
        it("should return on an unchanged message", async () => {
            discordBot = new modDiscordBot.DiscordBot(
                config,
                mockBridge,
                {},
            );

            const guild: any = new MockGuild("123", []);
            guild._mockAddMember(new MockMember("12345", "TestUsername"));
            const channel = new MockTextChannel(guild);
            const oldMsg = new MockMessage(channel) as any;
            const newMsg = new MockMessage(channel) as any;
            oldMsg.embeds = [];
            newMsg.embeds = [];

            // Content updated but not changed
            oldMsg.content = "a";
            newMsg.content = "a";

            // Mock the SendMatrixMessage method to check if it is called
            let checkMsgSent = false;
            discordBot.SendMatrixMessage = (...args) => checkMsgSent = true;

            await discordBot.OnMessageUpdate(oldMsg, newMsg);
            expect(checkMsgSent).to.be.false;
        });
        it("should send a matrix edit on an edited discord message", async () => {
            discordBot = new modDiscordBot.DiscordBot(
                config,
                mockBridge,
                {},
            );
            discordBot.store.Get = (a, b) => null;

            const guild: any = new MockGuild("123", []);
            guild._mockAddMember(new MockMember("12345", "TestUsername"));
            const channel = new MockTextChannel(guild);
            const oldMsg = new MockMessage(channel) as any;
            const newMsg = new MockMessage(channel) as any;
            oldMsg.embeds = [];
            newMsg.embeds = [];

            // Content updated and edited
            oldMsg.content = "a";
            newMsg.content = "b";

            let storeMockResults = 1;
            discordBot.store = {
                Get: (a, b) => {
                    return {
                        MatrixId: "editedid",
                        Next: () => storeMockResults--,
                        Result: true,
                    };
                },
            };

            let checkEditEventSent = "";
            discordBot.OnMessage = (str, event) => {
                checkEditEventSent = event;
            };

            await discordBot.OnMessageUpdate(oldMsg, newMsg);
            expect(checkEditEventSent).to.equal("editedid");
        });
        it("should send a new message if no store event found", async () => {
            discordBot = new modDiscordBot.DiscordBot(
                config,
                mockBridge,
                {},
            );
            discordBot.store.Get = (a, b) => { return {
                MatrixId: "$event:localhost;!room:localhost",
                Next: () => true,
                Result: true,
            }; };
            discordBot.lastEventIds["!room:localhost"] = "$event:localhost";

            const guild: any = new MockGuild("123", []);
            guild._mockAddMember(new MockMember("12345", "TestUsername"));
            const channel = new MockTextChannel(guild, {} as any);
            const oldMsg = new MockMessage(channel) as any;
            const newMsg = new MockMessage(channel) as any;
            oldMsg.embeds = [];
            newMsg.embeds = [];

            // Content updated and edited
            oldMsg.content = "a";
            newMsg.content = "b";

            let storeMockResults = 0;
            discordBot.store = {
                Get: (a, b) => {
                    return {
                        MatrixId: "editedid",
                        Next: () => storeMockResults--,
                        Result: true,
                    };
                },
            };

            let checkEditEventSent = "wrong";
            discordBot.OnMessage = (str, event) => {
                checkEditEventSent = event;
            };

            await discordBot.OnMessageUpdate(oldMsg, newMsg);
            expect(checkEditEventSent).to.be.undefined;
        });
    });
    describe("event:message", () => {
        it("should delay messages so they arrive in order", async () => {
            discordBot = new modDiscordBot.DiscordBot(
                config,
                mockBridge,
                {},
            );
            let expected = 0;
            discordBot.OnMessage = async (msg: any) => {
                expect(msg.n).to.eq(expected);
                expected++;
            };
            const client: MockDiscordClient = (await discordBot.ClientFactory.getClient()) as MockDiscordClient;
            await discordBot.run();
            const ITERATIONS = 25;
            const CHANID = 123;
            // Send delay of 50ms, 2 seconds / 50ms - 5 for safety.
            for (let i = 0; i < ITERATIONS; i++) {
                await client.emit("message", { channel: { guild: { id: CHANID }, id: CHANID} });
            }
            await discordBot.discordMessageQueue[CHANID];
        });
        it("should handle messages that reject in the queue", async () => {
            discordBot = new modDiscordBot.DiscordBot(
                config,
                mockBridge,
                {},
            );
            let expected = 0;
            const THROW_EVERY = 5;
            discordBot.OnMessage = async (msg: any) => {
                expect(msg.n).to.eq(expected);
                expected++;
                if (expected % THROW_EVERY === 0) {
                    return Promise.reject("Deliberate throw in test");
                }
                return Promise.resolve();
            };
            const client: MockDiscordClient = (await discordBot.ClientFactory.getClient()) as MockDiscordClient;
            await discordBot.run();
            const ITERATIONS = 25;
            const CHANID = 123;
            // Send delay of 50ms, 2 seconds / 50ms - 5 for safety.
            for (let n = 0; n < ITERATIONS; n++) {
                await client.emit("message", { n, channel: { guild: { id: CHANID }, id: CHANID} });
            }
            await discordBot.discordMessageQueue[CHANID];
            expect(expected).to.eq(ITERATIONS);
        });
    });
});
