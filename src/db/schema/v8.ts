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

import {IDbSchema} from "./dbschema";
import {DiscordStore} from "../../store";

export class Schema implements IDbSchema {
    public description = "create room store tables";

    constructor() {

    }

    public async run(store: DiscordStore): Promise<void> {
        await store.createTable(`
            CREATE TABLE remote_room_data (
                room_id TEXT NOT NULL,
                discord_guild TEXT NOT NULL,
                discord_channel TEXT NOT NULL,
                discord_name TEXT DEFAULT NULL,
                discord_topic TEXT DEFAULT NULL,
                discord_type TEXT DEFAULT NULL,
                discord_iconurl TEXT DEFAULT NULL,
                discord_iconurl_mxc TEXT DEFAULT NULL,
                update_name NUMERIC DEFAULT 0,
                update_topic NUMERIC DEFAULT 0,
                update_icon NUMERIC DEFAULT 0,
                plumbed NUMERIC DEFAULT 0,
                PRIMARY KEY(room_id)
        );`, "remote_room_data");

        await store.createTable(`
            CREATE TABLE room_entries (
                id TEXT NOT NULL,
                matrix_id TEXT,
                remote_id TEXT,
                PRIMARY KEY(id)
        );`, "room_entries");

        // XXX: This used to migrate rooms across from the old room store format but
        // since we moved to the matrix-js-bot-sdk, we can no longer do this. Please
        // use a 0.X release for this.
    }

    public async rollBack(store: DiscordStore): Promise<void> {
        await store.db.Run(
            `DROP TABLE IF EXISTS remote_room_data;`,
        );
        await store.db.Run(
            `DROP TABLE IF EXISTS room_entries;`,
        );
    }
}
