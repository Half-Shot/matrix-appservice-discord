import * as fs from "fs";
import { IDbSchema } from "./db/schema/dbschema";
import { IDbData} from "./db/dbdatainterface";
import { SQLite3 } from "./db/sqlite3";
import { Log } from "./log";
import { DiscordBridgeConfigDatabase } from "./config";
import { Postgres } from "./db/postgres";
import { IDatabaseConnector } from "./db/connector";
export const CURRENT_SCHEMA = 7;

const log = new Log("DiscordStore");
/**
 * Stores data for specific users and data not specific to rooms.
 */
export class DiscordStore {
  /**
   * @param  {string} filepath Location of the SQLite database file.
   */
  public db: IDatabaseConnector;
  private version: number;
  private config: DiscordBridgeConfigDatabase;
  constructor (private configOrFile: DiscordBridgeConfigDatabase|string) {
    if (typeof(configOrFile) === "string") {
        this.config = new DiscordBridgeConfigDatabase();
        this.config.filename = configOrFile;
    } else {
        this.config = configOrFile;
    }
    this.version = null;
  }

  public backup_database(): Promise<void|{}> {
    if (this.config.filename == null) {
        log.warn("Backups not supported on non-sqlite connector");
        return;
    }
    if (this.config.filename === ":memory:") {
      log.info("Can't backup a :memory: database.");
      return Promise.resolve();
    }
    const BACKUP_NAME = this.config.filename + ".backup";

    return new Promise((resolve, reject) => {
      // Check to see if a backup file already exists.
      fs.access(BACKUP_NAME, (err) => {
        return resolve(err === null);
      });
    }).then((result) => {
      return new Promise((resolve, reject) => {
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
  public async init (overrideSchema: number = 0): Promise<void> {
    log.info("Starting DB Init");
    await this.open_database();
    let version = await this.getSchemaVersion();
    const targetSchema = overrideSchema || CURRENT_SCHEMA;
    while (version < targetSchema) {
      version++;
      const schemaClass = require(`./db/schema/v${version}.js`).Schema;
      const schema = (new schemaClass() as IDbSchema);
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
      this.version = version;
      await this.setSchemaVersion(version);
    }
    log.info("Updated database to the latest schema");
  }

  public close () {
    this.db.Close();
  }

  public create_table (statement: string, tablename: string): Promise<void|Error> {
    return this.db.Exec(statement).then(() => {
      log.info("Created table", tablename);
    }).catch((err) => {
      throw new Error(`Error creating '${tablename}': ${err}`);
    });
  }

  public add_user_token(userId: string, discordId: string, token: string): Promise<any> {
    log.silly("SQL", "add_user_token => ", userId);
    return Promise.all([
        this.db.Run(
          `
          INSERT INTO user_id_discord_id (discord_id,user_id) VALUES ($discordId,$userId);
          `
        , {
            userId,
            discordId,
        }),
        this.db.Run(
          `
          INSERT INTO discord_id_token (discord_id,token) VALUES ($discordId,$token);
          `
        , {
            discordId,
            token,
        }),
    ]).catch( (err) => {
      log.error("Error storing user token ", err);
      throw err;
    });
  }

  public delete_user_token(discordId: string): Promise<null> {
    log.silly("SQL", "delete_user_token => ", discordId);
    return this.db.Run(
      `
      DELETE FROM user_id_discord_id WHERE discord_id = $id;
      DELETE FROM discord_id_token WHERE discord_id = $id;
      `
    , {
      $id: discordId,
    }).catch( (err) => {
      log.error("Error deleting user token ", err);
      throw err;
    });
  }

  public get_user_discord_ids(userId: string): Promise<string[]> {
    log.silly("SQL", "get_user_discord_ids => ", userId);
    return this.db.All(
      `
      SELECT discord_id
      FROM user_id_discord_id
      WHERE user_id = $userId;
      `, {
        userId,
      },
    ).then( (rows) => {
      if (rows != null) {
        return rows.map((row) => row.discord_id);
      } else {
        return [];
      }
    }).catch( (err) => {
      log.error("Error getting discord ids: ", err.Error);
      throw err;
    });
  }

  public get_token(discordId: string): Promise<string> {
    log.silly("SQL", "discord_id_token => ", discordId);
    return this.db.Get(
      `
      SELECT token
      FROM discord_id_token
      WHERE discord_id = $discordId
      `, {
        discordId,
      },
    ).then( (row) => {
      return row != null ? row.token : null;
    }).catch( (err) => {
      log.error("Error getting discord ids ", err.Error);
      throw err;
    });
  }

  public get_all_user_discord_ids(): Promise<any> {
    log.silly("SQL", "get_users_tokens");
    return this.db.All(
      `
      SELECT *
      FROM user_id_discord_id
      `,
    ).then( (rows) => {
      return rows;
    }).catch( (err) => {
      log.error("Error getting user token  ", err.Error);
      throw err;
    });
  }

  public Get<T extends IDbData>(dbType: {new(): T; }, params: any): Promise<T|null> {
      const dType = new dbType();
      log.silly(`get <${dType.constructor.name} with params ${params}>`);
      return dType.RunQuery(this, params).then(() => {
          log.silly(`Finished query with ${dType.Result ? "Results" : "No Results"}`);
          return dType;
      }).catch((ex) => {
          log.warn(`get <${dType.constructor.name} with params ${params} FAILED with exception ${ex}>`);
          return null;
      });
  }

  public Insert<T extends IDbData>(data: T): Promise<Error> {
      log.silly(`insert <${data.constructor.name}>`);
      return data.Insert(this);
  }

  public Update<T extends IDbData>(data: T): Promise<Error>  {
      log.silly(`insert <${data.constructor.name}>`);
      return data.Update(this);
  }

  public Delete<T extends IDbData>(data: T): Promise<Error>  {
      log.silly(`insert <${data.constructor.name}>`);
      return data.Delete(this);
  }

  private async getSchemaVersion ( ): Promise<number> {
    log.silly("_get_schema_version");
    let version = 0;
    try {
        version = await this.db.Get(`SELECT version FROM schema`);
    } catch (er) {
        log.warn("Couldn't fetch schema version, defaulting to 0");
    }
    return version;
  }

  private setSchemaVersion (ver: number): Promise<any> {
    log.silly("_set_schema_version => ", ver);
    return this.db.Run(
      `
      UPDATE schema
      SET version = $ver
      `, {ver},
    );
  }

  private async open_database(): Promise<void|Error> {
    if (this.config.filename) {
        log.info("Filename present in config, using sqlite");
        this.db = new SQLite3(this.config.filename);
    } else if (this.config.connString) {
        log.info("connString present in config, using postgres");
        this.db = new Postgres(this.config.connString);
    }
    try {
        this.db.Open();
    } catch (ex) {
      log.error("Error opening database:", ex);
      throw new Error("Couldn't open database. The appservice won't be able to continue.");
    }
  }
}
