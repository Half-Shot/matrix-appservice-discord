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

import * as fs from "fs";
import { IDbSchema } from "./db/schema/dbschema";
import { IDbData} from "./db/dbdatainterface";
import { SQLite3 } from "./db/sqlite3";
import { Log } from "./log";
import { DiscordBridgeConfigDatabase } from "./config";
import { Postgres } from "./db/postgres";
import { IDatabaseConnector } from "./db/connector";
import { DbRoomStore } from "./db/roomstore";
import { DbUserStore } from "./db/userstore";
import { IAppserviceStorageProvider } from "matrix-bot-sdk";
const log = new Log("DiscordStore");
export const CURRENT_SCHEMA = 11;
/**
 * Stores data for specific users and data not specific to rooms.
 */
export class DiscordStore implements IAppserviceStorageProvider {
    public db: IDatabaseConnector;
    private config: DiscordBridgeConfigDatabase;
    private pRoomStore: DbRoomStore;
    private pUserStore: DbUserStore;

    private registeredUsers: Set<string>;
    private asTxns: Set<string>;

    constructor(configOrFile: DiscordBridgeConfigDatabase|string) {
        if (typeof(configOrFile) === "string") {
            this.config = new DiscordBridgeConfigDatabase();
            this.config.filename = configOrFile;
        } else {
            this.config = configOrFile;
        }
        this.registeredUsers = new Set();
        this.asTxns = new Set();
    }

    get roomStore() {
        return this.pRoomStore;
    }

    get userStore() {
        return this.pUserStore;
    }

    public async backupDatabase(): Promise<void|true> {
        if (this.config.filename == null) {
            log.warn("Backups not supported on non-sqlite connector");
            return;
        }
        if (this.config.filename === ":memory:") {
            log.info("Can't backup a :memory: database.");
            return;
        }
        const BACKUP_NAME = this.config.filename + ".backup";

        return new Promise((resolve) => {
            // Check to see if a backup file already exists.
            fs.access(BACKUP_NAME, (err) => {
                return resolve(err === null);
            });
        }).then(async (result) => {
            return new Promise<void|true>((resolve, reject) => {
                if (!result) {
                    log.warn("NOT backing up database while a file already exists");
                    resolve(true);
                }
                const rd = fs.createReadStream(this.config.filename);
                rd.on("error", reject);
                const wr = fs.createWriteStream(BACKUP_NAME);
                wr.on("error", reject);
                wr.on("close", resolve);
                rd.pipe(wr);
            });
        });
    }

    /**
     * Checks the database has all the tables needed.
     */
    public async init(
        overrideSchema: number = 0,
    ): Promise<void> {
        log.info("Starting DB Init");
        await this.openDatabase();
        let version = await this.getSchemaVersion();
        const targetSchema = overrideSchema || CURRENT_SCHEMA;
        log.info(`Database schema version is ${version}, latest version is ${targetSchema}`);
        while (version < targetSchema) {
            version++;
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const schemaClass = require(`./db/schema/v${version}`).Schema;
            const schema: IDbSchema = (new schemaClass() as IDbSchema);
            log.info(`Updating database to v${version}, "${schema.description}"`);
            try {
                await schema.run(this);
                log.info("Updated database to version ", version);
            } catch (ex) {
                log.error("Couldn't update database to schema ", version);
                log.error(ex);
                log.info("Rolling back to version ", version - 1);
                try {
                    await schema.rollBack(this);
                } catch (ex) {
                    log.error(ex);
                    throw Error("Failure to update to latest schema. And failed to rollback.");
                }
                throw Error("Failure to update to latest schema.");
            }
            await this.setSchemaVersion(version);
        }
        log.info("Updated database to the latest schema");
        // We need to prepopulate some sets
        for (const row of await this.db.All("SELECT * FROM registered_users")) {
            this.registeredUsers.add(row.user_id as string);
        }

        for (const row of await this.db.All("SELECT * FROM as_txns")) {
            this.asTxns.add(row.txn_id as string);
        }
    }

    public async close() {
        await this.db.Close();
    }

    public async createTable(statement: string, tablename: string): Promise<void|Error> {
        try {
            await this.db.Exec(statement);
            log.info("Created table", tablename);
        } catch (err) {
            throw new Error(`Error creating '${tablename}': ${err}`);
        }
    }

    public async addUserToken(userId: string, discordId: string, token: string): Promise<void> {
        log.silly("SQL", "addUserToken => ", userId);
        try {
            await Promise.all([
                this.db.Run(
                    `INSERT INTO user_id_discord_id (discord_id,user_id) VALUES ($discordId,$userId);`
                    , {
                        discordId,
                        userId,
                    }),
                this.db.Run(
                    `INSERT INTO discord_id_token (discord_id,token) VALUES ($discordId,$token);`
                    , {
                        discordId,
                        token,
                    }),
            ]);
        } catch (err) {
            log.error("Error storing user token ", err);
            throw err;
        }
    }

    public async deleteUserToken(mxid: string): Promise<void> {
        const res = await this.db.Get("SELECT * from user_id_discord_id WHERE user_id = $id", {
            id: mxid,
        });
        if (!res) {
            return;
        }
        const discordId = res.discord_id;
        log.silly("SQL", "deleteUserToken => ", discordId);
        try {
            await Promise.all([
                this.db.Run(
                    `DELETE FROM user_id_discord_id WHERE discord_id = $id`
                    , {
                        id: discordId,
                    }),
                this.db.Run(
                    `DELETE FROM discord_id_token WHERE discord_id = $id`
                    , {
                        id: discordId,
                    }),
            ]);
        } catch (err) {
            log.error("Error deleting user token ", err);
            throw err;
        }
    }

    public async getUserDiscordIds(userId: string): Promise<string[]> {
        log.silly("SQL", "getUserDiscordIds => ", userId);
        try {
            const rows = await this.db.All(
                `
                SELECT discord_id
                FROM user_id_discord_id
                WHERE user_id = $userId;
                `
                , {
                    userId,
                });
            if (rows != null) {
                return rows.map((row) => row.discord_id as string);
            } else {
                return [];
            }
        } catch (err)  {
            log.error("Error getting discord ids: ", err.Error);
            throw err;
        }
    }

    public async getToken(discordId: string): Promise<string> {
        log.silly("SQL", "discord_id_token => ", discordId);
        try {
            const row = await this.db.Get(
                `
                SELECT token
                FROM discord_id_token
                WHERE discord_id = $discordId
                `
                , {
                    discordId,
                });
            return row ? row.token as string : "";
        } catch (err) {
            log.error("Error getting discord ids ", err.Error);
            throw err;
        }
    }

    public async Get<T extends IDbData>(dbType: {new(): T; }, params: unknown): Promise<T|null> {
        const dType = new dbType();
        log.silly(`get <${dType.constructor.name} with params ${params}>`);
        try {
            await dType.RunQuery(this, params);
            log.silly(`Finished query with ${dType.Result ? "Results" : "No Results"}`);
            return dType;
        } catch (ex) {
            log.warn(`get <${dType.constructor.name} with params ${params} FAILED with exception ${ex}>`);
            return null;
        }
    }

    public async Insert<T extends IDbData>(data: T): Promise<void> {
        log.silly(`insert <${data.constructor.name}>`);
        await data.Insert(this);
    }

    public async Update<T extends IDbData>(data: T): Promise<void>  {
        log.silly(`insert <${data.constructor.name}>`);
        await data.Update(this);
    }

    public async Delete<T extends IDbData>(data: T): Promise<void>  {
        log.silly(`insert <${data.constructor.name}>`);
        await data.Delete(this);
    }

    public addRegisteredUser(userId: string) {
        this.registeredUsers.add(userId);
        this.db.Run("INSERT INTO registered_users VALUES ($userId)", {userId}).catch((err) => {
            log.warn("Failed to insert registered user", err);
        });
    }
    public isUserRegistered(userId: string): boolean {
        return this.registeredUsers.has(userId);
    }

    public setTransactionCompleted(transactionId: string) {
        this.asTxns.add(transactionId);
        this.db.Run("INSERT INTO as_txns (txn_id) VALUES ($transactionId)", {transactionId}).catch((err) => {
            log.warn("Failed to insert txn", err);
        });
    }
    public isTransactionCompleted(transactionId: string): boolean {
        return this.asTxns.has(transactionId);
    }

    private async getSchemaVersion( ): Promise<number> {
        log.silly("_get_schema_version");
        let version = 0;
        try {
            const versionReply = await this.db.Get(`SELECT version FROM schema`);
            version = versionReply!.version as number;
        } catch (er) {
            log.warn("Couldn't fetch schema version, defaulting to 0");
        }
        return version;
    }

    private async setSchemaVersion(ver: number): Promise<void> {
        log.silly("_set_schema_version => ", ver);
        await this.db.Run(
            `
            UPDATE schema
            SET version = $ver
            `, {ver},
        );
    }

    private async openDatabase(): Promise<void|Error> {
        if (this.config.filename) {
            log.info("Filename present in config, using sqlite");
            this.db = new SQLite3(this.config.filename);
        } else if (this.config.connString) {
            log.info("connString present in config, using postgres");
            this.db = new Postgres(this.config.connString);
        }
        try {
            this.db.Open();
            this.pRoomStore = new DbRoomStore(this.db);
            this.pUserStore = new DbUserStore(this.db);
        } catch (ex) {
            log.error("Error opening database:", ex);
            throw new Error("Couldn't open database. The appservice won't be able to continue.");
        }
    }
}
