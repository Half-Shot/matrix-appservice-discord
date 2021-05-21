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
import { Log } from "../log";
import { IDatabaseConnector } from "./connector";
import { Util } from "../util";

import { v4 as uuid } from "uuid";
import { MetricPeg } from "../metrics";
import { TimedCache } from "../structures/timedcache";

const log = new Log("DbRoomStore");

/**
 * A RoomStore compatible with
 * https://github.com/matrix-org/matrix-appservice-bridge/blob/master/lib/components/room-bridge-store.js
 * that accesses the database instead.
 */

interface IRemoteRoomData extends IRemoteRoomDataLazy {
    discord_guild: string;
    discord_channel: string;
}

interface IRemoteRoomDataLazy  {
    discord_guild?: string;
    discord_channel?: string;
    discord_name?: string|null;
    discord_topic?: string|null;
    discord_type?: string|null;
    discord_iconurl?: string|null;
    discord_iconurl_mxc?: string|null;
    update_name?: number|boolean|null;
    update_topic?: number|boolean|null;
    update_icon?: number|boolean|null;
    plumbed?: number|boolean|null;
}

export class RemoteStoreRoom {
    public data: IRemoteRoomDataLazy;
    constructor(public readonly roomId: string, data: IRemoteRoomDataLazy) {
        for (const k of ["discord_guild", "discord_channel", "discord_name",
            "discord_topic", "discord_iconurl", "discord_iconurl_mxc", "discord_type"]) {
            data[k] = typeof(data[k]) === "number" ? String(data[k]) : data[k] || null;
        }
        for (const k of ["update_name", "update_topic", "update_icon", "plumbed"]) {
            data[k] = Number(data[k]) || 0;
        }
        this.data = data;
    }

    public getId() {
        return this.roomId;
    }

    public get(key: string): string|boolean|null {
        return this.data[key];
    }

    public set(key: string, value: string|boolean|null) {
        this.data[key] = typeof(value) === "boolean" ? Number(value) : value;
    }
}

export class MatrixStoreRoom {
    constructor(public readonly roomId: string) { }

    public getId() {
        return this.roomId;
    }
}

export interface IRoomStoreEntry {
    id: string;
    matrix: MatrixStoreRoom|null;
    remote: RemoteStoreRoom|null;
}

const ENTRY_CACHE_LIMETIME = 30000;

// XXX: This only implements functions used in the bridge at the moment.
export class DbRoomStore {

    private entriesMatrixIdCache: TimedCache<string, IRoomStoreEntry[]>;
    constructor(private db: IDatabaseConnector) {
        this.entriesMatrixIdCache = new TimedCache(ENTRY_CACHE_LIMETIME);
    }

    /**
     * Returns the number of bridged room pairs. Every connection between a
     * Matrix room and a remote room counts as one pair.
     * @returns {number} The amount of room pairs as an integer
     */
    public async countEntries(): Promise<number> {
        const row = (await this.db.Get("SELECT COUNT(*) AS count FROM room_entries WHERE matrix_id IS NOT NULL AND remote_id IS NOT NULL")) || {};

        // Our Sqlite wrapper returns a number – which is what we want.
        let count = row.count;
        // Our PostgreSQL wrapper returns a string.
        if (typeof count === 'string') {
            count = Number.parseInt(count);
        }

        if (typeof count !== "number") {
            log.error("Failed to count room entries");
            throw Error(`Failed to count room entries ${JSON.stringify(row)} AND ${typeof count}`);
        }

        return count;
    }

    public async upsertEntry(entry: IRoomStoreEntry) {
        const row = (await this.db.Get("SELECT * FROM room_entries WHERE id = $id", {id: entry.id})) || {};

        if (!row.id) {
            // Doesn't exist at all, create the room_entries row.
            const values = {
                id: entry.id,
                matrix: entry.matrix ? entry.matrix.roomId : null,
                remote: entry.remote ? entry.remote.roomId : null,
            };
            try {
                await this.db.Run(`INSERT INTO room_entries VALUES ($id, $matrix, $remote)`, values);
                log.verbose(`Created new entry ${entry.id}`);
            } catch (ex) {
                log.error("Failed to insert room entry", ex);
                throw Error("Failed to insert room entry");
            }
        }

        const matrixId = entry.matrix ? entry.matrix.roomId : null;
        const remoteId = entry.remote ? entry.remote.roomId : null;
        const mxIdDifferent = matrixId !== row.matrix_id;
        const rmIdDifferent = remoteId !== row.remote_id;
        // Did the room ids change?
        if (mxIdDifferent || rmIdDifferent) {
            if (matrixId) {
                this.entriesMatrixIdCache.delete(matrixId);
            }
            const items: string[] = [];

            if (mxIdDifferent) {
                items.push("matrix_id = $matrixId");
            }

            if (rmIdDifferent) {
                items.push("remote_id = $remoteId");
            }

            await this.db.Run(`UPDATE room_entries SET ${items.join(", ")} WHERE id = $id`,
                {
                    id: entry.id,
                    matrixId: matrixId as string|null,
                    remoteId: remoteId as string|null,
                },
            );
        }

        // Matrix room doesn't store any data.
        if (entry.remote) {
            await this.upsertRoom(entry.remote);
        }
    }

    public async getEntriesByMatrixId(matrixId: string): Promise<IRoomStoreEntry[]> {
        const cached = this.entriesMatrixIdCache.get(matrixId);
        if (cached) {
            MetricPeg.get.storeCall("RoomStore.getEntriesByMatrixId", true);
            return cached;
        }
        MetricPeg.get.storeCall("RoomStore.getEntriesByMatrixId", false);
        const entries = await this.db.All(
            "SELECT * FROM room_entries WHERE matrix_id = $id", {id: matrixId},
        );
        const res: IRoomStoreEntry[] = [];
        for (const entry of entries) {
            let remote: RemoteStoreRoom|null = null;
            if (entry.remote_id) {
                const remoteId = entry.remote_id as string;
                const row = await this.db.Get(
                    "SELECT * FROM remote_room_data WHERE room_id = $remoteId",
                    {remoteId},
                );
                if (row) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    remote = new RemoteStoreRoom(remoteId, row as any);
                }
            }
            if (remote) {
                // Only push rooms with a remote
                res.push({
                    id: (entry.id as string),
                    matrix: new MatrixStoreRoom(matrixId),
                    remote,
                });
            }
        }
        if (res.length > 0) {
            this.entriesMatrixIdCache.set(matrixId, res);
        }
        return res;
    }

    public async getEntriesByMatrixIds(matrixIds: string[]): Promise<IRoomStoreEntry[]> {
        MetricPeg.get.storeCall("RoomStore.getEntriesByMatrixIds", false);
        const mxIdMap = { };
        matrixIds.forEach((mxId, i) => mxIdMap[i] = mxId);
        const sql = `SELECT * FROM room_entries WHERE matrix_id IN (${matrixIds.map((_, id) => `\$${id}`).join(", ")})`;
        const entries = await this.db.All(sql, mxIdMap);
        const res: IRoomStoreEntry[] = [];
        for (const entry of entries) {
            let remote: RemoteStoreRoom|null = null;
            const matrixId = entry.matrix_id as string || "";
            const remoteId = entry.remote_id as string;
            if (remoteId) {
                const row = await this.db.Get(
                    "SELECT * FROM remote_room_data WHERE room_id = $rid",
                    {rid: remoteId},
                );
                if (row) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    remote = new RemoteStoreRoom(remoteId, row as any);
                }
            }
            if (remote) {
                // Only push rooms with a remote
                res.push({
                    id: (entry.id as string),
                    matrix: matrixId ? new MatrixStoreRoom(matrixId) : null,
                    remote,
                });
            }
        }
        return res;
    }

    public async linkRooms(matrixRoom: MatrixStoreRoom, remoteRoom: RemoteStoreRoom): Promise<void> {
        MetricPeg.get.storeCall("RoomStore.linkRooms", false);
        await this.upsertRoom(remoteRoom);

        const values = {
            id: uuid(),
            matrix: matrixRoom.roomId,
            remote: remoteRoom.roomId,
        };

        try {
            await this.db.Run(`INSERT INTO room_entries VALUES ($id, $matrix, $remote)`, values);
            log.verbose(`Created new entry ${values.id}`);
        } catch (ex) {
            log.error("Failed to insert room entry", ex);
            throw Error("Failed to insert room entry");
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async setMatrixRoom(matrixRoom: MatrixStoreRoom): Promise<void> {
        // This no-ops, because we don't store anything interesting.
    }

    public async getEntriesByRemoteRoomData(data: IRemoteRoomDataLazy): Promise<IRoomStoreEntry[]> {
        MetricPeg.get.storeCall("RoomStore.getEntriesByRemoteRoomData", false);
        Object.keys(data).filter((k) => typeof(data[k]) === "boolean").forEach((k) => {
            data[k] = Number(data[k]);
        });

        const whereClaues = Object.keys(data).map((key) => {
            return `${key} = $${key}`;
        }).join(" AND ");
        const sql = `
        SELECT * FROM remote_room_data
        INNER JOIN room_entries ON remote_room_data.room_id = room_entries.remote_id
        WHERE ${whereClaues}`;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (await this.db.All(sql, data as any)).map((row) => {
            const id = row.id as string;
            const matrixId = row.matrix_id;
            const remoteId = row.room_id;
            return {
                id,
                matrix: matrixId ? new MatrixStoreRoom(matrixId as string) : null,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                remote: matrixId ? new RemoteStoreRoom(remoteId as string, row as any) : null,
            };
        });
    }

    public async removeEntriesByRemoteRoomId(remoteId: string) {
        MetricPeg.get.storeCall("RoomStore.removeEntriesByRemoteRoomId", false);
        await this.db.Run(`DELETE FROM room_entries WHERE remote_id = $remoteId`, {remoteId});
        await this.db.Run(`DELETE FROM remote_room_data WHERE room_id = $remoteId`, {remoteId});
    }

    public async removeEntriesByMatrixRoomId(matrixId: string): Promise<void> {
        MetricPeg.get.storeCall("RoomStore.removeEntriesByMatrixRoomId", false);
        const entries = (await this.db.All(`SELECT * FROM room_entries WHERE matrix_id = $matrixId`, {matrixId})) || [];
        await Util.AsyncForEach(entries, async (entry) => {
            if (entry.remote_id) {
                await this.removeEntriesByRemoteRoomId(entry.remote_id as string);
            } else if (entry.matrix_id) {
                await this.db.Run(`DELETE FROM room_entries WHERE matrix_id = $matrixId`, {matrixId: entry.matrix_id});
            }
        });
    }

    private async upsertRoom(room: RemoteStoreRoom): Promise<void> {
        MetricPeg.get.storeCall("RoomStore.upsertRoom", false);
        if (!room.data) {
            throw new Error("Tried to upsert a room with undefined data");
        }

        const existingRow = await this.db.Get(
            "SELECT * FROM remote_room_data WHERE room_id = $id",
            {id: room.roomId},
        );

        const data = {
            discord_channel:     room.data.discord_channel,
            discord_guild:       room.data.discord_guild,
            discord_iconurl:     room.data.discord_iconurl,
            discord_iconurl_mxc: room.data.discord_iconurl_mxc,
            discord_name:        room.data.discord_name,
            discord_topic:       room.data.discord_topic,
            discord_type:        room.data.discord_type,
            plumbed:             Number(room.data.plumbed || 0),
            update_icon:         Number(room.data.update_icon || 0),
            update_name:         Number(room.data.update_name || 0),
            update_topic:        Number(room.data.update_topic || 0),
        } as IRemoteRoomData;

        if (!existingRow) {
            // Insert new data.
            await this.db.Run(
                `INSERT INTO remote_room_data VALUES (
                $id,
                $discord_guild,
                $discord_channel,
                $discord_name,
                $discord_topic,
                $discord_type,
                $discord_iconurl,
                $discord_iconurl_mxc,
                $update_name,
                $update_topic,
                $update_icon,
                $plumbed
            )
            `,
                {
                    id: room.roomId,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    ...data as any,
                });
            return;
        }

        const keysToUpdate = { } as IRemoteRoomDataLazy;

        // New keys
        Object.keys(room.data).filter(
            (k: string) => existingRow[k] === null).forEach((key) => {
            const val = room.data[key];
            keysToUpdate[key] = typeof val === "boolean" ? Number(val) : val;
        });

        // Updated keys
        Object.keys(room.data).filter(
            (k: string) => existingRow[k] !== room.data[k]).forEach((key) => {
            const val = room.data[key];
            keysToUpdate[key] = typeof val === "boolean" ? Number(val) : val;
        });

        if (Object.keys(keysToUpdate).length === 0) {
            return;
        }

        const setStatement = Object.keys(keysToUpdate).map((k) => {
            return `${k} = $${k}`;
        }).join(", ");

        try {
            await this.db.Run(`UPDATE remote_room_data SET ${setStatement} WHERE room_id = $id`,
                {
                    id: room.roomId,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    ...keysToUpdate as any,
                });
            log.verbose(`Upserted room ${  room.roomId}`);
        } catch (ex) {
            log.error("Failed to upsert room", ex);
            throw Error("Failed to upsert room");
        }
    }
}
