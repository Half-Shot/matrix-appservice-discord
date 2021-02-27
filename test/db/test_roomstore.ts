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
/* eslint-disable @typescript-eslint/camelcase */

import { expect } from "chai";
import { DiscordStore } from "../../src/store";
import { RemoteStoreRoom, MatrixStoreRoom } from "../../src/db/roomstore";

// we are a test file and thus need those
/* tslint:disable: no-any no-unused-expression */

let store: DiscordStore;
describe("RoomStore", () => {
    beforeEach(async () => {
        store = new DiscordStore(":memory:");
        await store.init();
    });
    describe("upsertEntry|getEntriesByMatrixId", () => {
        it("will create a new entry", async () => {
            await store.roomStore.upsertEntry({
                id: "test1",
                matrix: new MatrixStoreRoom("!abc:def.com"),
                remote: new RemoteStoreRoom("123456_789", {discord_guild: "123", discord_channel: "456"}),
            });
            const entry = (await store.roomStore.getEntriesByMatrixId("!abc:def.com"))[0];
            expect(entry.id).to.equal("test1");
            expect(entry.matrix!.roomId).to.equal("!abc:def.com");
            expect(entry.remote!.roomId).to.equal("123456_789");
            expect(entry.remote!.get("discord_guild")).to.equal("123");
            expect(entry.remote!.get("discord_channel")).to.equal("456");
        });
        it("will update an existing entry's rooms", async () => {
            await store.roomStore.upsertEntry({
                id: "test2",
                matrix: new MatrixStoreRoom("test2_m"),
                remote: new RemoteStoreRoom("test2_r", {discord_guild: "123", discord_channel: "456"}),
            });
            await store.roomStore.upsertEntry({
                id: "test2",
                matrix: new MatrixStoreRoom("test2_2m"),
                remote: new RemoteStoreRoom("test2_2r", {discord_guild: "555", discord_channel: "999"}),
            });
            const entry = (await store.roomStore.getEntriesByMatrixId("test2_2m"))[0];
            expect(entry.id).to.equal("test2");
            expect(entry.matrix!.roomId).to.equal("test2_2m");
            expect(entry.remote!.roomId).to.equal("test2_2r");
            expect(entry.remote!.get("discord_guild")).to.equal("555");
            expect(entry.remote!.get("discord_channel")).to.equal("999");
        });
        it("will add new data to an existing entry", async () => {
            await store.roomStore.upsertEntry({
                id: "test3",
                matrix: new MatrixStoreRoom("test3_m"),
                remote: new RemoteStoreRoom("test3_r", {discord_guild: "123", discord_channel: "456"}),
            });
            await store.roomStore.upsertEntry({
                id: "test3",
                matrix: new MatrixStoreRoom("test3_m"),
                remote: new RemoteStoreRoom("test3_r", {discord_guild: "123", discord_channel: "456", update_topic: 1}),
            });
            const entry = (await store.roomStore.getEntriesByMatrixId("test3_m"))[0];
            expect(entry.id).to.equal("test3");
            expect(entry.matrix!.roomId).to.equal("test3_m");
            expect(entry.remote!.roomId).to.equal("test3_r");
            expect(entry.remote!.get("update_topic")).to.equal(1);
        });
        it("will replace data on an existing entry", async () => {
            await store.roomStore.upsertEntry({
                id: "test3.1",
                matrix: new MatrixStoreRoom("test3.1_m"),
                remote: new RemoteStoreRoom("test3.1_r", {discord_guild: "123", discord_channel: "456"}),
            });
            await store.roomStore.upsertEntry({
                id: "test3.1",
                matrix: new MatrixStoreRoom("test3.1_m"),
                remote: new RemoteStoreRoom("test3.1_r", {discord_guild: "-100", discord_channel: "seventythousand"}),
            });
            const entry = (await store.roomStore.getEntriesByMatrixId("test3.1_m"))[0];
            expect(entry.id).to.equal("test3.1");
            expect(entry.matrix!.roomId).to.equal("test3.1_m");
            expect(entry.remote!.roomId).to.equal("test3.1_r");
            expect(entry.remote!.get("discord_guild")).to.equal("-100");
            expect(entry.remote!.get("discord_channel")).to.equal("seventythousand");
        });
        it("will delete data on an existing entry", async () => {
            await store.roomStore.upsertEntry({
                id: "test3.2",
                matrix: new MatrixStoreRoom("test3.2_m"),
                remote: new RemoteStoreRoom("test3.2_r", {
                    discord_channel: "456", discord_guild: "123",  update_icon: true,
                }),
            });
            await store.roomStore.upsertEntry({
                id: "test3.2",
                matrix: new MatrixStoreRoom("test3.2_m"),
                remote: new RemoteStoreRoom("test3.2_r", {discord_guild: "123", discord_channel: "456"}),
            });
            const entry = (await store.roomStore.getEntriesByMatrixId("test3.2_m"))[0];
            expect(entry.id).to.equal("test3.2");
            expect(entry.matrix!.roomId).to.equal("test3.2_m");
            expect(entry.remote!.roomId).to.equal("test3.2_r");
            expect(entry.remote!.get("update_icon")).to.be.eq(0);
        });
    });
    describe("getEntriesByMatrixIds", () => {
        it("will get multiple entries", async () => {
            const EXPECTED_ROOMS = 2;
            await store.roomStore.upsertEntry({
                id: "test4_1",
                matrix: new MatrixStoreRoom("!test_mOne:eggs.com"),
                remote: new RemoteStoreRoom("test4_r", {discord_guild: "five", discord_channel: "five"}),
            });
            await store.roomStore.upsertEntry({
                id: "test4_2",
                matrix: new MatrixStoreRoom("!test_mTwo:eggs.com"),
                remote: new RemoteStoreRoom("test4_r", {discord_guild: "nine", discord_channel: "nine"}),
            });
            const entries = await store.roomStore.getEntriesByMatrixIds(["!test_mOne:eggs.com", "!test_mTwo:eggs.com"]);
            expect(entries).to.have.lengthOf(EXPECTED_ROOMS);
            expect(entries[0].id).to.equal("test4_1");
            expect(entries[0].matrix!.roomId).to.equal("!test_mOne:eggs.com");
            expect(entries[1].id).to.equal("test4_2");
            expect(entries[1].matrix!.roomId).to.equal("!test_mTwo:eggs.com");
        });
    });
    describe("linkRooms", () => {
        it("will link a room", async () => {
            const matrix = new MatrixStoreRoom("test5_m");
            const remote = new RemoteStoreRoom("test5_r", {discord_guild: "five", discord_channel: "five"});
            await store.roomStore.linkRooms(matrix, remote);
            const entries = await store.roomStore.getEntriesByMatrixId("test5_m");
            expect(entries[0].matrix!.roomId).to.equal("test5_m");
            expect(entries[0].remote!.roomId).to.equal("test5_r");
            expect(entries[0].remote!.get("discord_guild")).to.equal("five");
            expect(entries[0].remote!.get("discord_channel")).to.equal("five");
        });
    });
    describe("getEntriesByRemoteRoomData", () => {
        it("will get an entry", async () => {
            await store.roomStore.upsertEntry({
                id: "test6",
                matrix: new MatrixStoreRoom("test6_m"),
                remote: new RemoteStoreRoom("test6_r", {discord_guild: "find", discord_channel: "this"}),
            });
            const entries = await store.roomStore.getEntriesByRemoteRoomData({
                discord_channel: "this",
                discord_guild: "find",
            });
            expect(entries[0].matrix!.roomId).to.equal("test6_m");
            expect(entries[0].remote!.roomId).to.equal("test6_r");
            expect(entries[0].remote!.get("discord_guild")).to.equal("find");
            expect(entries[0].remote!.get("discord_channel")).to.equal("this");
        });
    });
    describe("removeEntriesByRemoteRoomId", () => {
        it("will remove a room", async () => {
            await store.roomStore.upsertEntry({
                id: "test7",
                matrix: new MatrixStoreRoom("test7_m"),
                remote: new RemoteStoreRoom("test7_r", {discord_guild: "find", discord_channel: "this"}),
            });
            await store.roomStore.removeEntriesByRemoteRoomId("test7_r");
            const entries = await store.roomStore.getEntriesByMatrixId("test7_m");
            expect(entries).to.be.empty;
        });
    });
    describe("removeEntriesByMatrixRoomId", () => {
        it("will remove a room", async () => {
            await store.roomStore.upsertEntry({
                id: "test8",
                matrix: new MatrixStoreRoom("test8_m"),
                remote: new RemoteStoreRoom("test8_r", {discord_guild: "find", discord_channel: "this"}),
            });
            await store.roomStore.removeEntriesByRemoteRoomId("test8_m");
            const entries = await store.roomStore.getEntriesByMatrixId("test8_r");
            expect(entries).to.be.empty;
        });
    });
    describe("countEntries", () => {
        it("returns 0 when no entry has been upserted", async () => {
            expect(await store.roomStore.countEntries()).to.equal(0);
        });
        it("returns 1 when one entry has been upserted", async () => {
            await store.roomStore.upsertEntry({
                id: "test",
                matrix: new MatrixStoreRoom("test_m"),
                remote: new RemoteStoreRoom("test_r", { discord_guild: "find", discord_channel: "this" }),
            });
            expect(await store.roomStore.countEntries()).to.equal(1);
        });
        it("returns 2 when two entries have been upserted", async () => {
            await store.roomStore.upsertEntry({
                id: "test1",
                matrix: new MatrixStoreRoom("test1_m"),
                remote: new RemoteStoreRoom("test1_r", { discord_guild: "find", discord_channel: "this" }),
            });
            await store.roomStore.upsertEntry({
                id: "test2",
                matrix: new MatrixStoreRoom("test2_m"),
                remote: new RemoteStoreRoom("test2_r", { discord_guild: "find", discord_channel: "this" }),
            });
            expect(await store.roomStore.countEntries()).to.equal(2);
        });
        it("does not count entries with no matrix_id", async () => {
            await store.roomStore.upsertEntry({
                id: "test",
                matrix: null,
                remote: new RemoteStoreRoom("test_r", { discord_guild: "find", discord_channel: "this" }),
            });
            expect(await store.roomStore.countEntries()).to.equal(0);
        });
        it("does not count entries with no remote_id", async () => {
            await store.roomStore.upsertEntry({
                id: "test",
                matrix: new MatrixStoreRoom("test_m"),
                remote: null,
            });
            expect(await store.roomStore.countEntries()).to.equal(0);
        });
        it("returns 0 when one entry has been upserted and removed", async () => {
            await store.roomStore.upsertEntry({
                id: "test",
                matrix: new MatrixStoreRoom("test_m"),
                remote: new RemoteStoreRoom("test_r", { discord_guild: "find", discord_channel: "this" }),
            });
            await store.roomStore.removeEntriesByRemoteRoomId("test_r");
            expect(await store.roomStore.countEntries()).to.equal(0);
        });
    });
});
