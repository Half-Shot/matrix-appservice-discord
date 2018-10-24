import * as Chai from "chai";
import * as ChaiAsPromised from "chai-as-promised";
import * as Discord from "discord.js";
import * as Proxyquire from "proxyquire";

import { PresenceHandler } from "../src/presencehandler";
import { DiscordBot } from "../src/bot";
import { MockGuild } from "./mocks/guild";
import { MockCollection } from "./mocks/collection";
import { MockMember } from "./mocks/member";
import { MockEmoji } from "./mocks/emoji";
import {MatrixEventProcessor, MatrixEventProcessorOpts} from "../src/matrixeventprocessor";
import {DiscordBridgeConfig} from "../src/config";
import {MessageProcessor, MessageProcessorOpts} from "../src/messageprocessor";
import {MockChannel} from "./mocks/channel";

Chai.use(ChaiAsPromised);
const expect = Chai.expect;
// const assert = Chai.assert;
const bot = {
    GetIntentFromDiscordMember: (member) => {
        return {
            getClient: () => {
                return {

                };
            },
        };
    },
};

const mxClient = {
    mxcUrlToHttp: (url) => {
        return url.replace("mxc://", "https://");
    },
};

function createMatrixEventProcessor
    (disableMentions: boolean = false, disableEveryone = false, disableHere = false): MatrixEventProcessor {
    const bridge = {
        getClientFactory: () => {
            return {
                getClientAs: () => {
                    return mxClient;
                },
            };
        },
        getIntent: () => {
            return {
                getClient: () => {
                    return {
                        getUserId: () => {
                            return "@botuser:localhost";
                        },
                    };
                },
            };
        },
    };
    const config = new DiscordBridgeConfig();
    config.bridge.disableDiscordMentions = disableMentions;
    config.bridge.disableEveryoneMention = disableEveryone;
    config.bridge.disableHereMention = disableHere;
    return new (Proxyquire("../src/matrixeventprocessor", {
        "./util": {
            Util: {
                DownloadFile: (name: string) => {
                    const size = parseInt(name.substring(name.lastIndexOf("/") + 1), undefined);
                    return Buffer.alloc(size);
                },
            },
        },
    })).MatrixEventProcessor(
        new MatrixEventProcessorOpts(
            config,
            bridge,
    ));
}
const mockChannel = new MockChannel();
mockChannel.members.set("12345", new MockMember("12345", "testuser2"));

describe("MatrixEventProcessor", () => {
    describe("StateEventToMessage", () => {
        it("Should ignore unhandled states", () => {
            const processor = createMatrixEventProcessor();
            const event = {
                sender: "@user:localhost",
                type: "m.room.nonexistant",
            };
            const channel = new MockChannel("123456");
            const msg = processor.StateEventToMessage(event, channel as any);
            Chai.assert.equal(msg, undefined);
        });
        it("Should ignore bot user states", () => {
            const processor = createMatrixEventProcessor();
            const event = {
                sender: "@botuser:localhost",
                type: "m.room.member",
            };
            const channel = new MockChannel("123456");
            const msg = processor.StateEventToMessage(event, channel as any);
            Chai.assert.equal(msg, undefined);
        });
        it("Should echo name changes", () => {
            const processor = createMatrixEventProcessor();
            const event = {
                sender: "@user:localhost",
                type: "m.room.name",
                content: {
                    name: "Test Name",
                },
            };
            const channel = new MockChannel("123456");
            const msg = processor.StateEventToMessage(event, channel as any);
            Chai.assert.equal(msg, "`@user:localhost` set the name to `Test Name` on Matrix.");
        });
        it("Should echo topic changes", () => {
            const processor = createMatrixEventProcessor();
            const event = {
                sender: "@user:localhost",
                type: "m.room.topic",
                content: {
                    topic: "Test Topic",
                },
            };
            const channel = new MockChannel("123456");
            const msg = processor.StateEventToMessage(event, channel as any);
            Chai.assert.equal(msg, "`@user:localhost` set the topic to `Test Topic` on Matrix.");
        });
        it("Should echo joins", () => {
            const processor = createMatrixEventProcessor();
            const event = {
                sender: "@user:localhost",
                type: "m.room.member",
                content: {
                    membership: "join",
                },
                unsigned: {},
            };
            const channel = new MockChannel("123456");
            const msg = processor.StateEventToMessage(event, channel as any);
            Chai.assert.equal(msg, "`@user:localhost` joined the room on Matrix.");
        });
        it("Should echo invites", () => {
            const processor = createMatrixEventProcessor();
            const event = {
                sender: "@user:localhost",
                type: "m.room.member",
                content: {
                    membership: "invite",
                },
                unsigned: {},
                state_key: "@user2:localhost",
            };
            const channel = new MockChannel("123456");
            const msg = processor.StateEventToMessage(event, channel as any);
            Chai.assert.equal(msg, "`@user:localhost` invited `@user2:localhost` to the room on Matrix.");
        });
        it("Should echo kicks", () => {
            const processor = createMatrixEventProcessor();
            const event = {
                sender: "@user:localhost",
                type: "m.room.member",
                content: {
                    membership: "leave",
                },
                unsigned: {},
                state_key: "@user2:localhost",
            };
            const channel = new MockChannel("123456");
            const msg = processor.StateEventToMessage(event, channel as any);
            Chai.assert.equal(msg, "`@user:localhost` kicked `@user2:localhost` from the room on Matrix.");
        });
        it("Should echo leaves", () => {
            const processor = createMatrixEventProcessor();
            const event = {
                sender: "@user:localhost",
                type: "m.room.member",
                content: {
                    membership: "leave",
                },
                unsigned: {},
                state_key: "@user:localhost",
            };
            const channel = new MockChannel("123456");
            const msg = processor.StateEventToMessage(event, channel as any);
            Chai.assert.equal(msg, "`@user:localhost` left the room on Matrix.");
        });
        it("Should echo bans", () => {
            const processor = createMatrixEventProcessor();
            const event = {
                sender: "@user:localhost",
                type: "m.room.member",
                content: {
                    membership: "ban",
                },
                unsigned: {},
                state_key: "@user2:localhost",
            };
            const channel = new MockChannel("123456");
            const msg = processor.StateEventToMessage(event, channel as any);
            Chai.assert.equal(msg, "`@user:localhost` banned `@user2:localhost` from the room on Matrix.");
        });
    });
    describe("EventToEmbed", () => {
        it("Should contain a profile.", () => {
            const processor = createMatrixEventProcessor();
            const evt = processor.EventToEmbed({
                sender: "@test:localhost",
                content: {
                    body: "testcontent",
                },
            }, {
                displayname: "Test User",
                avatar_url: "mxc://localhost/avatarurl",
            }, mockChannel as any);
            Chai.assert.equal(evt.author.name, "Test User");
            Chai.assert.equal(evt.author.icon_url, "https://localhost/avatarurl");
            Chai.assert.equal(evt.author.url, "https://matrix.to/#/@test:localhost");
        });

        it("Should contain the users displayname if it exists.", () => {
            const processor = createMatrixEventProcessor();
            const evt = processor.EventToEmbed({
                sender: "@test:localhost",
                content: {
                    body: "testcontent",
                },
            }, {
                displayname: "Test User"}, mockChannel as any);
            Chai.assert.equal(evt.author.name, "Test User");
            Chai.assert.isUndefined(evt.author.icon_url);
            Chai.assert.equal(evt.author.url, "https://matrix.to/#/@test:localhost");
        });

        it("Should contain the users userid if the displayname is not set", () => {
            const processor = createMatrixEventProcessor();
            const evt = processor.EventToEmbed({
                sender: "@test:localhost",
                content: {
                    body: "testcontent",
                },
            }, null, mockChannel as any);
            Chai.assert.equal(evt.author.name, "@test:localhost");
            Chai.assert.isUndefined(evt.author.icon_url);
            Chai.assert.equal(evt.author.url, "https://matrix.to/#/@test:localhost");
        });

        it("Should use the userid when the displayname is too short", () => {
            const processor = createMatrixEventProcessor();
            const evt = processor.EventToEmbed({
                sender: "@test:localhost",
                content: {
                    body: "testcontent",
                },
            }, {
                displayname: "t"}, mockChannel as any);
            Chai.assert.equal(evt.author.name, "@test:localhost");
        });

        it("Should use the userid when displayname is too long", () => {
            const processor = createMatrixEventProcessor();
            const evt = processor.EventToEmbed({
                sender: "@test:localhost",
                content: {
                    body: "testcontent",
                },
            }, {
                displayname: "this is a very very long displayname that should be capped",
            }, mockChannel as any);
            Chai.assert.equal(evt.author.name, "@test:localhost");
        });

        it("Should cap the sender name if it is too long", () => {
            const processor = createMatrixEventProcessor();
            const evt = processor.EventToEmbed({
                sender: "@testwithalottosayaboutitselfthatwillgoonandonandonandon:localhost",
                content: {
                    body: "testcontent",
                },
            }, null, mockChannel as any);
            Chai.assert.equal(evt.author.name, "@testwithalottosayaboutitselftha");
        });

        it("Should contain the users avatar if it exists.", () => {
            const processor = createMatrixEventProcessor();
            const evt = processor.EventToEmbed({
                sender: "@test:localhost",
                content: {
                    body: "testcontent",
                },
            }, {avatar_url: "mxc://localhost/test"}, mockChannel as any);
            Chai.assert.equal(evt.author.name, "@test:localhost");
            Chai.assert.equal(evt.author.icon_url, "https://localhost/test");
            Chai.assert.equal(evt.author.url, "https://matrix.to/#/@test:localhost");
        });

        it("Should enable mentions if configured.", () => {
            const processor = createMatrixEventProcessor();
            const evt = processor.EventToEmbed({
                sender: "@test:localhost",
                content: {
                    body: "@testuser2 Hello!",
                },
            }, {avatar_url: "test"}, mockChannel as any);
            Chai.assert.equal(evt.description, "<@!12345> Hello!");
        });

        it("Should disable mentions if configured.", () => {
            const processor = createMatrixEventProcessor(true);
            const evt = processor.EventToEmbed({
                sender: "@test:localhost",
                content: {
                    body: "@testuser2 Hello!",
                },
            }, {avatar_url: "test"}, mockChannel as any);
            Chai.assert.equal(evt.description, "@testuser2 Hello!");
        });

        it("Should remove everyone mentions if configured.", () => {
            const processor = createMatrixEventProcessor(false, true);
            const evt = processor.EventToEmbed({
                sender: "@test:localhost",
                content: {
                    body: "@everyone Hello!",
                },
            }, {avatar_url: "test"}, mockChannel as any);
            Chai.assert.equal(evt.description, "@ everyone Hello!");
        });

        it("Should remove here mentions if configured.", () => {
            const processor = createMatrixEventProcessor(false, false, true);
            const evt = processor.EventToEmbed({
                sender: "@test:localhost",
                content: {
                    body: "@here Hello!",
                },
            }, {avatar_url: "test"}, mockChannel as any);
            Chai.assert.equal(evt.description, "@ here Hello!");
        });

        it("Should process custom discord emojis.", () => {
            const processor = createMatrixEventProcessor(false, false, true);
            const mockEmoji = new MockEmoji("123", "supercake");
            const mockCollectionEmojis = new MockCollection<string, MockEmoji>();
            mockCollectionEmojis.set("123", mockEmoji);
            const mockGuild = new MockGuild("123");
            mockGuild.emojis = mockCollectionEmojis;
            const mockChannelEmojis = new MockChannel("test", mockGuild);
            const evt = processor.EventToEmbed({
                sender: "@test:localhost",
                content: {
                    body: "I like :supercake:",
                },
            }, {avatar_url: "test"}, mockChannelEmojis as any);
            Chai.assert.equal(evt.description, "I like <:supercake:123>");
        });

        it("Should not process invalid custom discord emojis.", () => {
            const processor = createMatrixEventProcessor(false, false, true);
            const mockEmoji = new MockEmoji("123", "supercake");
            const mockCollectionEmojis = new MockCollection<string, MockEmoji>();
            mockCollectionEmojis.set("123", mockEmoji);
            const mockGuild = new MockGuild("123");
            mockGuild.emojis = mockCollectionEmojis;
            const mockChannelEmojis = new MockChannel("test", mockGuild);
            
            const evt = processor.EventToEmbed({
                sender: "@test:localhost",
                content: {
                    body: "I like :lamecake:",
                },
            }, {avatar_url: "test"}, mockChannelEmojis as any);
            Chai.assert.equal(evt.description, "I like :lamecake:");
        });
        it("Should replace /me with * displayname, and italicize message", () => {
            const processor = createMatrixEventProcessor();
            const evt = processor.EventToEmbed({
                sender: "@test:localhost",
                content: {
                    body: "likes puppies",
                    msgtype: "m.emote",
                },
            }, {
                displayname: "displayname",
            }, mockChannel as any);
            Chai.assert.equal(evt.description, "*displayname likes puppies*");
        });
        it("Should handle stickers.", () => {
            const processor = createMatrixEventProcessor();
            const evt = processor.EventToEmbed({
                sender: "@test:localhost",
                type: "m.sticker",
                content: {
                    body: "Bunnies",
                    url: "mxc://bunny",
                },
            }, {avatar_url: "test"}, mockChannel as any);
            Chai.assert.equal(evt.description, "");
        });
    });
    describe("FindMentionsInPlainBody", () => {
        it("processes mentioned username correctly", async () => {
            const processor = createMatrixEventProcessor();
            const guild: any = new MockGuild("123", []);
            const members: Discord.GuildMember[] = [new Discord.GuildMember(guild, {
                user: {
                    username: "TestUsername",
                    id: "12345",
                    discriminator: "54321",
                },
            })];
            Chai.assert.equal(
                processor.FindMentionsInPlainBody("Hello TestUsername", members),
                "Hello <@!12345>",
            );
            Chai.assert.equal(
                processor.FindMentionsInPlainBody("Hello TestUsername#54321", members),
                "Hello <@!12345>",
            );
            Chai.assert.equal(
                processor.FindMentionsInPlainBody("I really love going to https://TestUsername.com", members),
                "I really love going to https://TestUsername.com",
            );
            Chai.assert.equal(
                processor.FindMentionsInPlainBody("I really love going to www.TestUsername.com", members),
                "I really love going to www.TestUsername.com",
            );
        });
        it("processes mentioned nickname correctly", async () => {
            const processor = createMatrixEventProcessor();
            const guild: any = new MockGuild("123", []);
            const members: Discord.GuildMember[] = [new Discord.GuildMember(guild, {
                nick: "Test",
                user: {
                    username: "Test",
                    id: "54321",
                },
            }), new Discord.GuildMember(guild, {
                nick: "TestNickname",
                user: {
                    username: "TestUsername",
                    id: "12345",
                },
            }), new Discord.GuildMember(guild, {
                nick: "𝖘𝖔𝖒𝖊𝖋𝖆𝖓𝖈𝖞𝖓𝖎𝖈𝖐𝖓𝖆𝖒𝖊",
                user: {
                    username: "SomeFancyNickname",
                    id: "66666",
                },
            })];
            Chai.assert.equal(processor.FindMentionsInPlainBody("Hello TestNickname", members), "Hello <@!12345>");
            Chai.assert.equal(processor.FindMentionsInPlainBody("TestNickname: Hello", members), "<@!12345>: Hello");
            Chai.assert.equal(processor.FindMentionsInPlainBody("TestNickname, Hello", members), "<@!12345>, Hello");
            Chai.assert.equal(processor.FindMentionsInPlainBody("TestNickname Hello", members), "<@!12345> Hello");
            Chai.assert.equal(processor.FindMentionsInPlainBody("testNicKName Hello", members), "<@!12345> Hello");
            Chai.assert.equal(
                processor.FindMentionsInPlainBody("𝖘𝖔𝖒𝖊𝖋𝖆𝖓𝖈𝖞𝖓𝖎𝖈𝖐𝖓𝖆𝖒𝖊 Hello", members),
                "<@!66666> Hello",
            );
            Chai.assert.equal(
                processor.FindMentionsInPlainBody("I wish TestNickname was here", members),
                "I wish <@!12345> was here",
            );
            Chai.assert.equal(
                processor.FindMentionsInPlainBody("I wish TestNickname was here, TestNickname is cool", members),
                "I wish <@!12345> was here, <@!12345> is cool",
            );
            Chai.assert.equal(
                processor.FindMentionsInPlainBody("TestNickname was here with Test", members),
                "<@!12345> was here with <@!54321>",
            );
            Chai.assert.equal(
                processor.FindMentionsInPlainBody("Fixing this issue provided by @Test", members),
                "Fixing this issue provided by <@!54321>",
            );
            Chai.assert.equal(
                processor.FindMentionsInPlainBody("I really love going to https://Test.com", members),
                "I really love going to https://Test.com",
            );
            Chai.assert.equal(
                processor.FindMentionsInPlainBody("I really love going to www.Test.com", members),
                "I really love going to www.Test.com",
            );
        });
        it("processes non-mentions correctly", async () => {
            const processor = createMatrixEventProcessor();
            const guild: any = new MockGuild("123", []);
            const members: Discord.GuildMember[] = [new Discord.GuildMember(guild, {
                nick: "that",
                user: {
                    username: "TestUsername",
                    id: "12345",
                },
            }),
                new Discord.GuildMember(guild, {
                    nick: "testingstring",
                    user: {
                        username: "that",
                        id: "12345",
                    },
                })];
            const msg = "Welcome thatman";
            const content = processor.FindMentionsInPlainBody(msg, members);
            Chai.assert.equal(content, "Welcome thatman");
        });
    });
    describe("HandleAttachment", () => {
        const SMALL_FILE = 200;
        it("message without an attachment", () => {
            const processor = createMatrixEventProcessor();
            return expect(processor.HandleAttachment({
                content: {
                    msgtype: "m.text",
                },
            }, mxClient)).to.eventually.eq("");
        });
        it("message without an info", () => {
            const processor = createMatrixEventProcessor();
            return expect(processor.HandleAttachment({
                content: {
                    msgtype: "m.video",
                    body: "filename.webm",
                    url: "mxc://localhost/200",
                },
            }, mxClient)).to.eventually.satisfy((attachment) => {
                expect(attachment.name).to.eq("filename.webm");
                expect(attachment.attachment.length).to.eq(SMALL_FILE);
                return true;
            });
        });
        it("message without a url", () => {
            const processor = createMatrixEventProcessor();
            return expect(processor.HandleAttachment({
                content: {
                    msgtype: "m.video",
                    info: {
                        size: 1,
                    },
                },
            }, mxClient)).to.eventually.eq("");
        });
        it("message with a large info.size", () => {
            const LARGE_FILE = 8000000;
            const processor = createMatrixEventProcessor();
            return expect(processor.HandleAttachment({
                content: {
                    msgtype: "m.video",
                    info: {
                        size: LARGE_FILE,
                    },
                    body: "filename.webm",
                    url: "mxc://localhost/8000000",
                },
            }, mxClient)).to.eventually.eq("[filename.webm](https://localhost/8000000)");
        });
        it("message with a small info.size", () => {
            const processor = createMatrixEventProcessor();
            return expect(processor.HandleAttachment({
                content: {
                    msgtype: "m.video",
                    info: {
                        size: SMALL_FILE,
                    },
                    body: "filename.webm",
                    url: "mxc://localhost/200",
                },
            }, mxClient)).to.eventually.satisfy((attachment) => {
                expect(attachment.name).to.eq("filename.webm");
                expect(attachment.attachment.length).to.eq(SMALL_FILE);
                return true;
            });
        });
        it("message with a small info.size but a larger file", () => {
            const processor = createMatrixEventProcessor();
            return expect(processor.HandleAttachment({
                content: {
                    msgtype: "m.video",
                    info: {
                        size: 200,
                    },
                    body: "filename.webm",
                    url: "mxc://localhost/8000000",
                },
            }, mxClient)).to.eventually.eq("[filename.webm](https://localhost/8000000)");
        });
        it("Should handle stickers.", () => {
            const processor = createMatrixEventProcessor();
            return expect(processor.HandleAttachment({
                sender: "@test:localhost",
                type: "m.sticker",
                content: {
                    body: "Bunnies",
                    url: "mxc://bunny",
                    info: {
                        mimetype: "image/png",
                    },
                },
            }, mxClient)).to.eventually.satisfy((attachment) => {
                expect(attachment.name).to.eq("Bunnies.png");
                return true;
            });
        });
    });
});
