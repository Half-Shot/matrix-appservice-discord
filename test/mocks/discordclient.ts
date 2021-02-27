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

import {MockCollectionManager} from "./collection";
import {MockGuild} from "./guild";
import {MockUser} from "./user";

// we are a test file and thus need those
/* tslint:disable:no-unused-expression max-file-line-count no-any */

export class MockDiscordClient {
    public guilds = new MockCollectionManager<string, MockGuild>();
    public user: MockUser;
    private testCallbacks: Map<string, (...data: any[]) => void> = new Map();

    constructor() {
        const channels = [
            {
                id: "321",
                name: "achannel",
                type: "text",
            },
            {
                id: "654",
                name: "a-channel",
                type: "text",
            },
            {
                id: "987",
                name: "a channel",
                type: "text",
            },
        ];
        this.guilds.cache.set("123", new MockGuild("MyGuild", channels));
        this.guilds.cache.set("456", new MockGuild("My Spaces Gui", channels));
        this.guilds.cache.set("789", new MockGuild("My Dash-Guild", channels));
        this.user = new MockUser("12345");
    }

    public on(event: string, callback: (...data: any[]) => void) {
        this.testCallbacks.set(event, callback);
    }

    public once(event: string, callback: (...data: any[]) => void) {
        this.testCallbacks.set(event, () => {
            this.testCallbacks.delete(event);
            callback();
        });
    }

    public async emit(event: string, ...data: any[]) {
        return await this.testCallbacks.get(event)!.apply(this, data);
    }

    public async login(token: string): Promise<void> {
        if (token !== "passme") {
            throw new Error("Mock Discord Client only logins with the token 'passme'");
        }
        if (this.testCallbacks.has("ready")) {
            this.testCallbacks.get("ready")!();
        }
        if (this.testCallbacks.has("shardReady")) {
            this.testCallbacks.get("shardReady")!();
        }
        return;
    }

    public async destroy() { } // no-op
}
