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

import { ChannelSyncroniser } from "../src/channelsyncroniser";
import { MockGuild } from "./mocks/guild";
import { DiscordBridgeConfig } from "../src/config";
import { Util } from "../src/util";
import { MockChannel } from "./mocks/channel";
import { MatrixStoreRoom, RemoteStoreRoom, IRoomStoreEntry } from "../src/db/roomstore";
import { Appservice } from "matrix-bot-sdk";
import { AppserviceMock } from "./mocks/appservicemock";

let REMOTECHANNEL_SET: any = false;
let REMOTECHANNEL_REMOVED: any = false;

const ChannelSync = (Proxyquire("../src/channelsyncroniser", {
    "./util": {
        Util: {
            ApplyPatternString: Util.ApplyPatternString,
            DownloadFile: () => ({buffer: "afile"}),
        },
    },
})).ChannelSyncroniser;

class Entry implements IRoomStoreEntry {
    public id: any;
    public matrix: MatrixStoreRoom|null;
    public remote: RemoteStoreRoom|null;
    public data: any;
    constructor(doc: any = {}) {
        this.matrix = doc.matrix_id ? new MatrixStoreRoom(doc.matrix_id) : null;
        this.remote = doc.remote_id ? new RemoteStoreRoom(doc.remote_id, doc.remote) : null;
        this.data = doc.data;
    }
}

function CreateChannelSync(remoteChannels: any[] = []) {
    const bridge = new AppserviceMock({
        aliasPrefix: "#_discord_",
        homeserverName: "localhost",
        stateEventFetcher: async (roomId: string, type: string, key: string) => {
            if (roomId === "!valid:localhost" && type === "m.room.canonical_alias" && key === "") {
                return { alias: "#alias:localhost"};
            }
            throw Error("Event not found");
        },
    });
    REMOTECHANNEL_REMOVED = false;
    REMOTECHANNEL_SET = false;
    const roomStore = {
        getEntriesByMatrixId: (roomid) => {
            const entries: any[] = [];
            remoteChannels.forEach((c) => {
                const mxid = c.matrix.getId();
                if (roomid === mxid) {
                    entries.push(c);
                }
            });
            return entries;
        },
        getEntriesByMatrixIds: (roomids) => {
            const entries = {};
            remoteChannels.forEach((c) => {
                const mxid = c.matrix.getId();
                if (roomids.includes(mxid)) {
                    if (!entries[mxid]) {
                        entries[mxid] = [];
                    }
                    entries[mxid].push(c);
                }
            });
            return entries;
        },
        getEntriesByRemoteRoomData: (data) => {
            return remoteChannels.filter((c) => {
                for (const d of Object.keys(data)) {
                    if (c.remote.get(d) !== data[d]) {
                        return false;
                    }
                }
                return true;
            });
        },
        removeEntriesByMatrixRoomId: () => {
            REMOTECHANNEL_REMOVED = true;
        },
        upsertEntry: () => {
            REMOTECHANNEL_SET = true;
        },
    };
    const discordbot: any = {

    };
    const config = new DiscordBridgeConfig();
    config.bridge.domain = "localhost";
    config.channel.namePattern = "[Discord] :guild :name";
    const fakedBridge = bridge as any;
    const channelSync = new ChannelSync(fakedBridge as Appservice, config, discordbot, roomStore) as ChannelSyncroniser;
    return {channelSync, bridge};
}

describe("ChannelSyncroniser", () => {
    describe("HandleChannelDelete", () => {
        it("will not delete non-text channels", async () => {
            const chan = new MockChannel();
            chan.id = "blah";
            chan.type = "voice";
            const testStore = [
                new Entry({
                    id: "1",
                    matrix_id: "!1:localhost",
                    remote: {
                        discord_channel: chan.id,
                    },
                    remote_id: "111",
                }),
            ];

            const {channelSync} = CreateChannelSync(testStore);
            await channelSync.OnDelete(chan as any);

            expect(REMOTECHANNEL_REMOVED).is.false;
        });
        it("will delete text channels", async () => {
            const chan = new MockChannel();
            chan.id = "blah";
            chan.type = "text";
            const testStore = [
                new Entry({
                    id: "1",
                    matrix_id: "!1:localhost",
                    remote: {
                        discord_channel: chan.id,
                    },
                    remote_id: "111",
                }),
            ];

            const {channelSync} = CreateChannelSync(testStore);
            await channelSync.OnDelete(chan as any);

            expect(REMOTECHANNEL_REMOVED).is.true;
        });
    });
    describe("GetRoomIdsFromChannel", () => {
        it("should get one room ID", async () => {
            const chan = new MockChannel();
            chan.id = "blah";
            const testStore = [
                new Entry({
                    id: "1",
                    matrix_id: "!1:localhost",
                    remote: {
                        discord_channel: chan.id,
                    },
                    remote_id: "111",
                }),
            ];

            const {channelSync} = CreateChannelSync(testStore);
            const chans = await channelSync.GetRoomIdsFromChannel(chan as any);

            expect(chans.length).equals(1);
            expect(chans[0]).equals("!1:localhost");
        });
        it("should get multiple room IDs", async () => {
            const chan = new MockChannel();
            chan.id = "blah";
            const testStore = [
                new Entry({
                    id: "1",
                    matrix_id: "!1:localhost",
                    remote: {
                        discord_channel: chan.id,
                    },
                    remote_id: "111",
                }),
                new Entry({
                    id: "2",
                    matrix_id: "!2:localhost",
                    remote: {
                        discord_channel: chan.id,
                    },
                    remote_id: "111",
                }),
                new Entry({
                    id: "3",
                    matrix_id: "!3:localhost",
                    remote: {
                        discord_channel: "no",
                    },
                    remote_id: "false",
                }),
            ];

            const {channelSync} = CreateChannelSync(testStore);
            const chans = await channelSync.GetRoomIdsFromChannel(chan as any);
            expect(chans.length).equals(2);
            expect(chans[0]).equals("!1:localhost");
            expect(chans[1]).equals("!2:localhost");
        });
        it("should reject on no rooms", async () => {
            const chan = new MockChannel();
            chan.id = "blah";
            const {channelSync} = CreateChannelSync();
            try {
                await channelSync.GetRoomIdsFromChannel(chan as any);
                throw new Error("didn't fail");
            } catch (e) {
                expect(e.message).to.not.equal("didn't fail");
            }
        });
    });
    describe("GetAliasFromChannel", () => {
        const getIds = async (chan) => {
            if (chan.id === "678") {
                return ["!valid:localhost"];
            }
            throw new Error("invalid");
        };
        it("Should get one canonical alias for a room", async () => {
            const chan = new MockChannel();
            chan.id = "678";
            const {channelSync} = CreateChannelSync();
            channelSync.GetRoomIdsFromChannel = getIds;
            const alias = await channelSync.GetAliasFromChannel(chan as any);
            expect(alias).to.equal("#alias:localhost");
        });
        it("Should prefer non-discord canonical aliases", async () => {
            const {channelSync} = CreateChannelSync();
            channelSync.GetRoomIdsFromChannel = async (_) => {
                return ["!discord:localhost", "!valid:localhost"];
            };
            const alias = await channelSync.GetAliasFromChannel({} as any);

            expect(alias).to.equal("#alias:localhost");
        });
        it("Should use discord canonical alias if none other present", async () => {
            const {channelSync} = CreateChannelSync();
            channelSync.GetRoomIdsFromChannel = async (_) => {
                return ["!discord:localhost"];
            };
            const alias = await channelSync.GetAliasFromChannel({
                guild: { id: "123" },
                id: "123",
            } as any);

            expect(alias).to.equal("#_discord_123_123:localhost");
        });
        it("Should return null if no alias found and no guild present", async () => {
            const chan = new MockChannel();
            chan.id = "123";
            const {channelSync} = CreateChannelSync();
            channelSync.GetRoomIdsFromChannel = getIds;
            const alias = await channelSync.GetAliasFromChannel(chan as any);
            expect(alias).to.equal(null);
        });
        it("Should return a #_discord_ alias if a guild is present", async () => {
            const chan = new MockChannel();
            const guild = new MockGuild("123");
            chan.id = "123";
            chan.guild = guild;
            const {channelSync} = CreateChannelSync();
            channelSync.GetRoomIdsFromChannel = getIds;
            const alias = await channelSync.GetAliasFromChannel(chan as any);
            expect(alias).to.equal("#_discord_123_123:localhost");
        });
    });
    describe("GetChannelUpdateState", () => {
        it("will do nothing on no rooms", async () => {
            const chan = new MockChannel();
            chan.type = "text";
            chan.id = "blah";

            const {channelSync} = CreateChannelSync();
            const state = await channelSync.GetChannelUpdateState(chan as any);
            expect(state.id).equals(chan.id);
            expect(state.mxChannels.length).equals(0);
        });
        it("will update name and topic", async () => {
            const guild = new MockGuild("654321", [], "newGuild");
            const chan = new MockChannel();
            chan.type = "text";
            chan.id = "blah";
            chan.name = "newName";
            chan.topic = "newTopic";
            chan.guild = guild;

            const testStore = [
                new Entry({
                    id: "1",
                    matrix_id: "!1:localhost",
                    remote: {
                        discord_channel: chan.id,
                        discord_name: "[Discord] oldGuild oldName",
                        discord_topic: "oldTopic",
                        update_name: true,
                        update_topic: true,
                    },
                    remote_id: "111",
                }),
            ];

            const {channelSync} = CreateChannelSync(testStore);
            const state = await channelSync.GetChannelUpdateState(chan as any);
            expect(state.mxChannels.length).equals(1);
            expect(state.mxChannels[0].name).equals("[Discord] newGuild #newName");
            expect(state.mxChannels[0].topic).equals("newTopic");
        });
        it("won't update name and topic if props not set", async () => {
            const guild = new MockGuild("654321", [], "newGuild");
            const chan = new MockChannel();
            chan.type = "text";
            chan.id = "blah";
            chan.name = "newName";
            chan.topic = "newTopic";
            chan.guild = guild;

            const testStore = [
                new Entry({
                    id: "1",
                    matrix_id: "!1:localhost",
                    remote: {
                        discord_channel: chan.id,
                        discord_name: "[Discord] oldGuild oldName",
                        discord_topic: "oldTopic",
                    },
                    remote_id: "111",
                }),
            ];

            const {channelSync} = CreateChannelSync(testStore);
            const state = await channelSync.GetChannelUpdateState(chan as any);
            expect(state.mxChannels.length).equals(1);
            expect(state.mxChannels[0].name).is.null;
            expect(state.mxChannels[0].topic).is.null;
        });
        it("won't update name and topic if not changed", async () => {
            const guild = new MockGuild("654321", [], "newGuild");
            const chan = new MockChannel();
            chan.type = "text";
            chan.id = "blah";
            chan.name = "newName";
            chan.topic = "newTopic";
            chan.guild = guild;

            const testStore = [
                new Entry({
                    id: "1",
                    matrix_id: "!1:localhost",
                    remote: {
                        discord_channel: chan.id,
                        discord_name: "[Discord] newGuild #newName",
                        discord_topic: "newTopic",
                        update_name: true,
                        update_topic: true,
                    },
                    remote_id: "111",
                }),
            ];

            const {channelSync} = CreateChannelSync(testStore);
            const state = await channelSync.GetChannelUpdateState(chan as any);
            expect(state.mxChannels.length).equals(1);
            expect(state.mxChannels[0].name).is.null;
            expect(state.mxChannels[0].topic).is.null;
        });
        it("will update the icon", async () => {
            const guild = new MockGuild("654321", [], "newGuild");
            guild.icon = "new_icon";
            const chan = new MockChannel();
            chan.type = "text";
            chan.id = "blah";
            chan.guild = guild;

            const testStore = [
                new Entry({
                    id: "1",
                    matrix_id: "!1:localhost",
                    remote: {
                        discord_channel: chan.id,
                        discord_iconurl: "https://cdn.discordapp.com/icons/654321/old_icon.png",
                        update_icon: true,
                    },
                    remote_id: "111",
                }),
            ];

            const {channelSync} = CreateChannelSync(testStore);
            const state = await channelSync.GetChannelUpdateState(chan as any);
            expect(state.mxChannels.length).equals(1);
            expect(state.mxChannels[0].iconUrl).equals("https://cdn.discordapp.com/icons/654321/new_icon.png");
            expect(state.mxChannels[0].iconId).equals("new_icon");
        });
        it("will update animated icons", async () => {
            const guild = new MockGuild("654321", [], "newGuild");
            guild.icon = "a_new_icon";
            const chan = new MockChannel();
            chan.type = "text";
            chan.id = "blah";
            chan.guild = guild;

            const testStore = [
                new Entry({
                    id: "1",
                    matrix_id: "!1:localhost",
                    remote: {
                        discord_channel: chan.id,
                        discord_iconurl: "https://cdn.discordapp.com/icons/654321/old_icon.png",
                        update_icon: true,
                    },
                    remote_id: "111",
                }),
            ];

            const { channelSync } = CreateChannelSync(testStore);
            const state = await channelSync.GetChannelUpdateState(chan as any);
            expect(state.mxChannels.length).equals(1);
            expect(state.mxChannels[0].iconUrl).equals("https://cdn.discordapp.com/icons/654321/a_new_icon.gif");
            expect(state.mxChannels[0].iconId).equals("a_new_icon");
        });
        it("won't update the icon", async () => {
            const guild = new MockGuild("654321", [], "newGuild");
            guild.icon = "new_icon";
            const chan = new MockChannel();
            chan.type = "text";
            chan.id = "blah";
            chan.guild = guild;

            const testStore = [
                new Entry({
                    id: "1",
                    matrix_id: "!1:localhost",
                    remote: {
                        discord_channel: chan.id,
                        discord_iconurl: "https://cdn.discordapp.com/icons/654321/new_icon.png",
                        update_icon: true,
                    },
                    remote_id: "111",
                }),
            ];

            const {channelSync} = CreateChannelSync(testStore);
            const state = await channelSync.GetChannelUpdateState(chan as any);
            expect(state.mxChannels.length).equals(1);
            expect(state.mxChannels[0].iconUrl).is.null;
            expect(state.mxChannels[0].iconId).is.null;
        });
        it("will delete the icon", async () => {
            const guild = new MockGuild("654321", [], "newGuild");
            guild.icon = "";
            const chan = new MockChannel();
            chan.type = "text";
            chan.id = "blah";
            chan.guild = guild;

            const testStore = [
                new Entry({
                    id: "1",
                    matrix_id: "!1:localhost",
                    remote: {
                        discord_channel: chan.id,
                        discord_iconurl: "https://cdn.discordapp.com/icons/654321/icon.png",
                        update_icon: true,
                    },
                    remote_id: "111",
                }),
            ];

            const {channelSync} = CreateChannelSync(testStore);
            const state = await channelSync.GetChannelUpdateState(chan as any);
            expect(state.mxChannels.length).equals(1);
            expect(state.mxChannels[0].removeIcon).is.true;
        });
    });
    describe("OnUpdate", () => {
        it("Will update a room", async () => {
            const guild = new MockGuild("654321", [], "newGuild");
            guild.icon = "new_icon";
            const chan = new MockChannel();
            chan.type = "text";
            chan.id = "blah";
            chan.name = "newName";
            chan.topic = "newTopic";
            chan.guild = guild;

            const testStore = [
                new Entry({
                    id: "1",
                    matrix_id: "!1:localhost",
                    remote: {
                        discord_channel: chan.id,
                        discord_iconurl: "https://cdn.discordapp.com/icons/654321/old_icon.png",
                        discord_name: "[Discord] oldGuild #oldName",
                        discord_topic: "oldTopic",
                        update_icon: true,
                        update_name: true,
                        update_topic: true,
                    },
                    remote_id: "111",
                }),
            ];

            const {channelSync, bridge} = CreateChannelSync(testStore);
            await channelSync.OnUpdate(chan as any);
            bridge.botIntent.underlyingClient.wasCalled("sendStateEvent", true, "!1:localhost", "m.room.name", "", {
                name: "[Discord] newGuild #newName",
            });
            bridge.botIntent.underlyingClient.wasCalled("sendStateEvent", true, "!1:localhost", "m.room.topic", "", {
                topic: "newTopic",
            });
            bridge.botIntent.underlyingClient.wasCalled("sendStateEvent", true, "!1:localhost", "m.room.avatar", "",
                {
                    url: "mxc://new_icon",
                }
            );
            expect(REMOTECHANNEL_SET).is.true;
        });
    });
});
