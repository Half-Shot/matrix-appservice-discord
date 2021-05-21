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

import {IDbSchema} from "./dbschema";
import {DiscordStore} from "../../store";
export class Schema implements IDbSchema {
    public description = "Create DM Table, User Options";
    public async run(store: DiscordStore): Promise<void> {
        await Promise.all([
            store.createTable(`
            CREATE TABLE dm_rooms (
                discord_id	TEXT NOT NULL,
                channel_id	TEXT NOT NULL,
                room_id	TEXT UNIQUE NOT NULL
            );`, "dm_rooms"),
            store.createTable(`
            CREATE TABLE client_options (
                discord_id	TEXT UNIQUE NOT NULL,
                options	INTEGER NOT NULL
            );`, "client_options",
            )]);
    }
    public async rollBack(store: DiscordStore): Promise<void> {
        await store.db.Exec(
            `DROP TABLE IF EXISTS dm_rooms;
            DROP TABLE IF EXISTS client_options;`,
        );
    }
}
