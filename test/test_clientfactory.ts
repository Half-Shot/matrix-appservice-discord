/*
Copyright 2018 matrix-appservice-discord

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
import { DiscordBridgeConfigAuth } from "../src/config";

const DiscordClientFactory = Proxyquire("../src/clientfactory", {
    "better-discord.js": { Client: require("./mocks/discordclient").MockDiscordClient },
}).DiscordClientFactory;

const STORE = {
    getToken: async (discordid: string) => {
        if (discordid === "12345") {
            return "passme";
        } else if (discordid === "1234555") {
            return "failme";
        }
        throw new Error("Token not found");
    },
    getUserDiscordIds: async (userid: string) => {
        if (userid === "@valid:localhost") {
            return ["12345"];
        } else if (userid === "@invalid:localhost") {
            return ["1234555"];
        }
        return [];
    },
};

describe("ClientFactory", () => {
    describe("init", () => {
        it ("should start successfully", async () => {
            const config = new DiscordBridgeConfigAuth();
            config.botToken = "passme";
            const cf = new DiscordClientFactory(null, config);
            await cf.init();
        });
        it ("should fail if a config is not supplied", async () => {
            const cf = new DiscordClientFactory(null);
            try {
                await cf.init();
                throw new Error("didn't fail");
            } catch (e) {
                expect(e.message).to.not.equal("didn't fail");
            }
        });
        it ("should fail if the bot fails to connect", async () => {
            const config = new DiscordBridgeConfigAuth();
            config.botToken = "failme";
            const cf = new DiscordClientFactory(null, config);
            try {
                await cf.init();
                throw new Error("didn't fail");
            } catch (e) {
                expect(e.message).to.not.equal("didn't fail");
            }
        });
    });
    describe("getDiscordId", () => {
        it("should fetch id successfully", async () => {
            const config = new DiscordBridgeConfigAuth();
            const cf = new DiscordClientFactory(null, config);
            const discordId = await cf.getDiscordId("passme");
            expect(discordId).equals("12345");
        });
        it("should fail if the token is not recognised", async () => {
            const config = new DiscordBridgeConfigAuth();
            const cf = new DiscordClientFactory(null, config);
            try {
                await cf.getDiscordId("failme");
                throw new Error("didn't fail");
            } catch (e) {
                expect(e.message).to.not.equal("didn't fail");
            }
        });
    });
    describe("getClient", () => {
        it("should fetch bot client successfully", async () => {
            const config = new DiscordBridgeConfigAuth();
            config.botToken = "passme";
            const cf = new DiscordClientFactory(null, config);
            cf.botClient = 1;
            const client = await cf.getClient();
            expect(client).equals(cf.botClient);
        });
        it("should return cached client", async () => {
            const config = new DiscordBridgeConfigAuth();
            const cf = new DiscordClientFactory(null, config);
            cf.clients.set("@user:localhost", "testclient");
            const client = await cf.getClient("@user:localhost");
            expect(client).equals("testclient");
        });
        it("should fetch bot client if userid doesn't match", async () => {
            const config = new DiscordBridgeConfigAuth();
            const cf = new DiscordClientFactory(STORE);
            cf.botClient = 1;
            const client = await cf.getClient("@user:localhost");
            expect(client).equals(cf.botClient);
        });
        it("should fetch user client if userid matches", async () => {
            const config = new DiscordBridgeConfigAuth();
            const cf = new DiscordClientFactory(STORE, config);
            const client = await cf.getClient("@valid:localhost");
            expect(client).is.not.null;
            expect(cf.clients.has("@valid:localhost")).to.be.true;
        });
        it("should fail if the user client cannot log in", async () => {
            const config = new DiscordBridgeConfigAuth();
            const cf = new DiscordClientFactory(STORE, config);
            cf.botClient = 1;
            const client = await cf.getClient("@invalid:localhost");
            expect(client).to.equal(cf.botClient);
            expect(cf.clients.has("@invalid:localhost")).to.be.false;
        });
    });
});
