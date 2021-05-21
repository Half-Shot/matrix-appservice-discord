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

import { DiscordBridgeConfigAuth } from "./config";
import { DiscordStore } from "./store";
import { Client as DiscordClient, Intents, TextChannel } from "better-discord.js";
import { Log } from "./log";
import { MetricPeg } from "./metrics";

const log = new Log("ClientFactory");

export class DiscordClientFactory {
    private config: DiscordBridgeConfigAuth;
    private store: DiscordStore;
    private botClient: DiscordClient;
    private clients: Map<string, DiscordClient>;
    constructor(store: DiscordStore, config?: DiscordBridgeConfigAuth) {
        this.config = config!;
        this.clients = new Map();
        this.store = store;
    }

    public async init(): Promise<void> {
        if (this.config === undefined) {
            return Promise.reject("Client config not supplied.");
        }
        // We just need to make sure we have a bearer token.
        // Create a new Bot client.
        this.botClient = new DiscordClient({
            fetchAllMembers: this.config.usePrivilegedIntents,
            messageCacheLifetime: 5,
            ws: {
                intents: this.config.usePrivilegedIntents ? Intents.ALL : Intents.NON_PRIVILEGED,
            },
        });

        const waitPromise = new Promise((resolve, reject) => {
            this.botClient.once("shardReady", resolve);
            this.botClient.once("shardError", reject);
        });

        try {
            await this.botClient.login(this.config.botToken, true);
            log.info("Waiting for shardReady signal");
            await waitPromise;
            log.info("Got shardReady signal");
        } catch (err) {
            log.error("Could not login as the bot user. This is bad!", err);
            throw err;
        }

    }

    public async getDiscordId(token: string): Promise<string> {
        const client = new DiscordClient({
            fetchAllMembers: false,
            messageCacheLifetime: 5,
            ws: {
                intents: Intents.NON_PRIVILEGED,
            },
        });

        await client.login(token, false);
        const id = client.user?.id;
        client.destroy();
        if (!id) {
            throw Error("Client did not have a user object, cannot determine ID");
        }
        return id;
    }

    public async getClient(userId: string | null = null): Promise<DiscordClient> {
        if (userId === null) {
            return this.botClient;
        }

        if (this.clients.has(userId)) {
            log.verbose("Returning cached user client for", userId);
            return this.clients.get(userId) as DiscordClient;
        }

        const discordIds = await this.store.getUserDiscordIds(userId);
        if (discordIds.length === 0) {
            return this.botClient;
        }
        // TODO: Select a profile based on preference, not the first one.
        const token = await this.store.getToken(discordIds[0]);
        const client = new DiscordClient({
            fetchAllMembers: false,
            messageCacheLifetime: 5,
            ws: {
                intents: Intents.NON_PRIVILEGED,
            },
        });

        const jsLog = new Log("discord.js-ppt");
        client.on("debug", (msg) => { jsLog.verbose(msg); });
        client.on("error", (msg) => { jsLog.error(msg); });
        client.on("warn", (msg) => { jsLog.warn(msg); });

        try {
            await client.login(token, false);
            log.verbose("Logged in. Storing ", userId);
            this.clients.set(userId, client);
            return client;
        } catch (err) {
            log.warn(`Could not log ${userId} in. Returning bot user for now.`, err);
            return this.botClient;
        }
    }

    public bindMetricsToChannel(channel: TextChannel) {
        // eslint-disable-next-line @typescript-eslint/ban-types
        const flexChan = channel as { _xmet_send?: Function };
        if (flexChan._xmet_send !== undefined) {
            return;
        }
        // Prefix the real functions with _xmet_
        flexChan._xmet_send = channel.send;
        channel.send = (...rest) => {
            MetricPeg.get.remoteCall("channel.send");
            return flexChan._xmet_send!.apply(channel, rest);
        };
    }
}
