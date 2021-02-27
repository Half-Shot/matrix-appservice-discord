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

import {MockMember} from "./member";
import {MockCollection} from "./collection";
import {Permissions, PermissionResolvable, TextChannel} from "better-discord.js";
import { MockGuild } from "./guild";

// we are a test file and thus need those
/* tslint:disable:no-unused-expression max-file-line-count no-any */

// Mocking TextChannel
export class MockChannel {
    public members = new MockCollection<string, MockMember>();
    constructor(
        public id: string = "",
        public guild: any = null,
        public type: string = "text",
        public name: string = "",
        public topic: string = "",
    ) { }

    public async send(data: any): Promise<any> {
        return data;
    }

    public permissionsFor(member: MockMember) {
        return new Permissions(Permissions.FLAGS.MANAGE_WEBHOOKS as PermissionResolvable);
    }
}

export class MockTextChannel extends TextChannel {
    constructor(guild?: MockGuild, channelData: any = {}) {
        // Mock the nessacery
        super(guild || {
            client: {
                options: {
                    messageCacheMaxSize: -1,
                },
            },
        } as any, channelData);
    }
}
