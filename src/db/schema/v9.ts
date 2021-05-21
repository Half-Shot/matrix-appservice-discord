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

import { IDbSchema } from "./dbschema";
import { DiscordStore } from "../../store";

export class Schema implements IDbSchema {
    public description = "create user store tables";

    public async run(store: DiscordStore): Promise<void> {
        await store.createTable(`
            CREATE TABLE remote_user_guild_nicks (
                remote_id TEXT NOT NULL,
                guild_id TEXT NOT NULL,
                nick TEXT NOT NULL,
                PRIMARY KEY(remote_id, guild_id)
        );`, "remote_user_guild_nicks");

        await store.createTable(`
            CREATE TABLE remote_user_data (
                remote_id TEXT NOT NULL,
                displayname TEXT,
                avatarurl TEXT,
                avatarurl_mxc TEXT,
                PRIMARY KEY(remote_id)
        );`, "remote_user_data");

        await store.createTable(`
            CREATE TABLE user_entries (
                matrix_id TEXT,
                remote_id TEXT,
                PRIMARY KEY(matrix_id, remote_id)
        );`, "user_entries");

        // XXX: This used to migrate rooms across from the old room store format but
        // since we moved to the matrix-js-bot-sdk, we can no longer do this. Please
        // use a 0.X release for this.
    }

    public async rollBack(store: DiscordStore): Promise<void> {
        await store.db.Run(
            `DROP TABLE IF EXISTS remote_user_guild_nicks;`,
        );
        await store.db.Run(
            `DROP TABLE IF EXISTS remote_user_data;`,
        );
        await store.db.Run(
            `DROP TABLE IF EXISTS user_entries;`,
        );
    }
}
