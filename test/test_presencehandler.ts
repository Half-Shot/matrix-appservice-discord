/*
Copyright 2017, 2018 matrix-appservice-discord

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

import { PresenceHandler } from "../src/presencehandler";
import { DiscordBot } from "../src/bot";
import { MockUser } from "./mocks/user";
import { AppserviceMock } from "./mocks/appservicemock";
import { MockPresence } from "./mocks/presence";

// we are a test file and thus need those
/* tslint:disable:no-unused-expression max-file-line-count no-any */

const INTERVAL = 250;
let lastStatus = null;
const appservice = new AppserviceMock();
const bot: any = {
    GetBotId: () => {
        return "1234";
    },
    GetIntentFromDiscordMember: (member: MockUser) => {
        return appservice.getIntentForSuffix(member.id);
    },
};

describe("PresenceHandler", () => {
    describe("init", () => {
        it("constructor", () => {
           new PresenceHandler(bot as DiscordBot);
        });
    });
    describe("Stop", () => {
        it("should start and stop without errors", async () => {
            const handler = new PresenceHandler(bot as DiscordBot);
            await handler.Start(INTERVAL);
            handler.Stop();
        });
    });
    describe("EnqueueUser", () => {
        it("adds a user properly", () => {
            const handler = new PresenceHandler(bot as DiscordBot);
            const COUNT = 2;
            handler.EnqueueUser(new MockPresence(new MockUser("abc", "alice"), "def") as any);
            handler.EnqueueUser(new MockPresence(new MockUser("123", "bob"), "ghi") as any);
            expect(handler.QueueCount).to.be.equal(COUNT);
        });
        it("does not add duplicate users", () => {
            const handler = new PresenceHandler(bot as DiscordBot);
            handler.EnqueueUser(new MockPresence(new MockUser("123", "alice"), "def") as any);
            handler.EnqueueUser(new MockPresence(new MockUser("123", "alice"), "def") as any);
            expect(handler.QueueCount).to.be.equal(1);
        });
        it("does not add the bot user", () => {
            const handler = new PresenceHandler(bot as DiscordBot);
            handler.EnqueueUser(new MockPresence(new MockUser("1234", "bob"), "ghi") as any);
            expect(handler.QueueCount).to.be.equal(0);
        });
    });
    describe("DequeueUser", () => {
        it("removes users properly", () => {
            const handler = new PresenceHandler(bot as DiscordBot);
            const members = [
                new MockPresence(new MockUser("abc", "alice"), "def") as any,
                new MockPresence(new MockUser("def", "bob"), "ghi") as any,
                new MockPresence(new MockUser("ghi", "foo"), "wew") as any,
            ];
            handler.EnqueueUser(members[0]);
            handler.EnqueueUser(members[1]);
            handler.EnqueueUser(members[2]);

            handler.DequeueUser(members[2].user);
            expect(handler.QueueCount).to.be.equal(members.length - 1);
            handler.DequeueUser(members[1].user);
            expect(handler.QueueCount).to.be.equal(1);
            handler.DequeueUser(members[0].user);
            expect(handler.QueueCount).to.be.equal(0);
        });
    });
    describe("ProcessUser", () => {
        it("processes an online user", async () => {
            lastStatus = null;
            const handler = new PresenceHandler(bot as DiscordBot);
            const member = new MockPresence(new MockUser("ghi", "alice"), "def", "online");
            await handler.ProcessUser(member as any);
            appservice.getIntentForSuffix(member.userID)
                .underlyingClient.wasCalled("setPresenceStatus", true, "online", "");
        });
        it("processes an offline user", async () => {
            lastStatus = null;
            const handler = new PresenceHandler(bot as DiscordBot);
            const member = new MockPresence(new MockUser("abc", "alice"), "def", "offline");
            await handler.ProcessUser(member as any);
            appservice.getIntentForSuffix(member.userID)
                .underlyingClient.wasCalled("setPresenceStatus", true, "offline", "");
        });
        it("processes an idle user", async () => {
            lastStatus = null;
            const handler = new PresenceHandler(bot as DiscordBot);
            const member = new MockPresence(new MockUser("abc", "alice"), "def", "idle");
            await handler.ProcessUser(member as any);
            appservice.getIntentForSuffix(member.userID)
                .underlyingClient.wasCalled("setPresenceStatus", true, "unavailable", "");
        });
        it("processes an dnd user", async () => {
            lastStatus = null;
            const handler = new PresenceHandler(bot as DiscordBot);
            const member = new MockPresence(new MockUser("abc", "alice"), "def", "dnd");
            await handler.ProcessUser(member as any);
            appservice.getIntentForSuffix(member.userID)
                .underlyingClient.wasCalled("setPresenceStatus", true, "online", "Do not disturb");
            const member2 = new MockPresence(new MockUser("abc", "alice"), "def", "dnd", [{name: "Test Game", type: "PLAYING"}]);
            await handler.ProcessUser(member2  as any);
            appservice.getIntentForSuffix(member.userID)
                .underlyingClient.wasCalled("setPresenceStatus", true, "online", "Do not disturb | Playing Test Game");
        });
        it("processes a user playing games", async () => {
            lastStatus = null;
            const handler = new PresenceHandler(bot as DiscordBot);
            const member = new MockPresence(new MockUser("abc", "alice"), "def", "online", [{name: "Test Game", type: "PLAYING"}]);
            await handler.ProcessUser(member  as any);
            appservice.getIntentForSuffix(member.userID)
                .underlyingClient.wasCalled("setPresenceStatus", true, "online", "Playing Test Game");
            const member2 = new MockPresence(new MockUser("abc", "alice"), "def", "online", [{name: "Test Game", type: "STREAMING"}]);
            await handler.ProcessUser(member2  as any);
            appservice.getIntentForSuffix(member.userID)
                .underlyingClient.wasCalled("setPresenceStatus", true, "online", "Streaming Test Game");
        });
    });
});
