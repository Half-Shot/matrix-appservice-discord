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

import { DiscordStore } from "../store";
import { IDbData } from "./dbdatainterface";
import { ISqlCommandParameters } from "./connector";

export class DbEmoji implements IDbData {
    public EmojiId: string;
    public Name: string;
    public Animated: boolean;
    public MxcUrl: string;
    public CreatedAt: number;
    public UpdatedAt: number;
    public Result: boolean;

    public async RunQuery(store: DiscordStore, params: ISqlCommandParameters): Promise<void> {
        let query = `
            SELECT *
            FROM emoji
            WHERE emoji_id = $id`;
        if (params.mxc_url) {
            query = `
                SELECT *
                FROM emoji
                WHERE mxc_url = $mxc`;
        }
        const row = await store.db.Get(query, {
            id: params.emoji_id,
            mxc: params.mxc_url,
        });
        this.Result = Boolean(row); // check if row exists
        if (this.Result && row) {
            this.EmojiId = row.emoji_id as string;
            this.Name = row.name as string;
            this.Animated = Boolean(row.animated);
            this.MxcUrl = row.mxc_url as string;
            this.CreatedAt = row.created_at as number;
            this.UpdatedAt = row.updated_at as number;
        }
    }

    public async Insert(store: DiscordStore): Promise<void> {
        this.CreatedAt = new Date().getTime();
        this.UpdatedAt = this.CreatedAt;
        await store.db.Run(`
            INSERT INTO emoji
            (emoji_id,name,animated,mxc_url,created_at,updated_at)
            VALUES ($emoji_id,$name,$animated,$mxc_url,$created_at,$updated_at);`, {
            animated: Number(this.Animated),
            created_at: this.CreatedAt,
            emoji_id: this.EmojiId,
            mxc_url: this.MxcUrl,
            name: this.Name,
            updated_at: this.UpdatedAt,
        });
    }

    public async Update(store: DiscordStore): Promise<void> {
        // Ensure this has incremented by 1 for Insert+Update operations.
        this.UpdatedAt = new Date().getTime() + 1;
        await store.db.Run(`
            UPDATE emoji
            SET name = $name,
            animated = $animated,
            mxc_url = $mxc_url,
            updated_at = $updated_at
            WHERE
            emoji_id = $emoji_id`, {
            animated: Number(this.Animated),
            emoji_id: this.EmojiId,
            mxc_url: this.MxcUrl,
            name: this.Name,
            updated_at: this.UpdatedAt,
        });
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async Delete(store: DiscordStore): Promise<void> {
        throw new Error("Delete is not implemented");
    }
}
