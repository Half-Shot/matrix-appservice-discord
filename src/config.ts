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

const ENV_PREFIX = "APPSERVICE_DISCORD";
const ENV_KEY_SEPARATOR = "_";
const ENV_VAL_SEPARATOR = ",";

/** Type annotations for config/config.schema.yaml */
export class DiscordBridgeConfig {
    public bridge: DiscordBridgeConfigBridge = new DiscordBridgeConfigBridge();
    public auth: DiscordBridgeConfigAuth = new DiscordBridgeConfigAuth();
    public logging: DiscordBridgeConfigLogging = new DiscordBridgeConfigLogging();
    public database: DiscordBridgeConfigDatabase = new DiscordBridgeConfigDatabase();
    public room: DiscordBridgeConfigRoom = new DiscordBridgeConfigRoom();
    public channel: DiscordBridgeConfigChannel = new DiscordBridgeConfigChannel();
    public limits: DiscordBridgeConfigLimits = new DiscordBridgeConfigLimits();
    public ghosts: DiscordBridgeConfigGhosts = new DiscordBridgeConfigGhosts();
    public metrics: DiscordBridgeConfigMetrics = new DiscordBridgeConfigMetrics();

    /**
     * Apply a set of keys and values over the default config.
     * @param newConfig Config keys
     * @param configLayer Private parameter
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public applyConfig(newConfig: {[key: string]: any}, configLayer: {[key: string]: any} = this) {
          Object.keys(newConfig).forEach((key) => {
            if (configLayer[key] instanceof Object && !(configLayer[key] instanceof Array)) {
                this.applyConfig(newConfig[key], configLayer[key]);
            } else {
                configLayer[key] = newConfig[key];
            }
        });
    }

    /**
     * Override configuration keys defined in the supplied environment dictionary.
     * @param environment environment variable dictionary
     * @param path private parameter: config layer path determining the environment key prefix
     * @param configLayer private parameter: current layer of configuration to alter recursively
     */
    public applyEnvironmentOverrides(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        environment: {[key: string]: any},
        path: string[] = [ENV_PREFIX],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        configLayer: {[key: string]: any} = this,
    ) {
        Object.keys(configLayer).forEach((key) => {
            // camelCase to THICK_SNAKE
            const attributeKey = key.replace(/[A-Z]/g, (prefix) => `${ENV_KEY_SEPARATOR}${prefix}`).toUpperCase();
            const attributePath = path.concat([attributeKey]);

            if (configLayer[key] instanceof Object && !(configLayer[key] instanceof Array)) {
                this.applyEnvironmentOverrides(environment, attributePath, configLayer[key]);
            } else {
                const lookupKey = attributePath.join(ENV_KEY_SEPARATOR);
                if (lookupKey in environment) {
                    configLayer[key] = (configLayer[key] instanceof Array)
                        ? environment[lookupKey].split(ENV_VAL_SEPARATOR)
                        : environment[lookupKey];
                }
            }
        });
    }
}

class DiscordBridgeConfigBridge {
    public domain: string;
    public homeserverUrl: string;
    public port: number;
    public bindAddress: string;
    public presenceInterval: number = 500;
    public disablePresence: boolean;
    public disableTypingNotifications: boolean;
    public disableDiscordMentions: boolean;
    public disableDeletionForwarding: boolean;
    public enableSelfServiceBridging: boolean;
    public disablePortalBridging: boolean;
    public disableReadReceipts: boolean;
    public disableEveryoneMention: boolean = false;
    public disableHereMention: boolean = false;
    public disableJoinLeaveNotifications: boolean = false;
    public disableInviteNotifications: boolean = false;
    public determineCodeLanguage: boolean = false;
    public userBlacklist: RegExp[] = [];

    public IsUserBlacklisted(userId: string): boolean {
        return !!userId && this.userBlacklist.some((regex) => RegExp(regex).test(userId));
    }
}

export class DiscordBridgeConfigDatabase {
    public connString: string;
    public filename: string;
    // These parameters are legacy, and will stop the bridge if defined.
    public userStorePath: string;
    public roomStorePath: string;
}

export class DiscordBridgeConfigAuth {
    public clientID: string;
    public botToken: string;
    public usePrivilegedIntents: boolean;
}

export class DiscordBridgeConfigLogging {
    public console: string = "info";
    public lineDateFormat: string = "MMM-D HH:mm:ss.SSS";
    public files: LoggingFile[] = [];
}

class DiscordBridgeConfigRoom {
    public defaultVisibility: string;
    public kickFor: number = 30000;
}

class DiscordBridgeConfigChannel {
    public namePattern: string = "[Discord] :guild :name";
    public deleteOptions = new DiscordBridgeConfigChannelDeleteOptions();
}

export class DiscordBridgeConfigChannelDeleteOptions {
    public namePrefix: string | null = null;
    public topicPrefix: string | null = null;
    public disableMessaging: boolean = false;
    public unsetRoomAlias: boolean = true;
    public unlistFromDirectory: boolean = true;
    public setInviteOnly: boolean = true;
    public ghostsLeave: boolean = true;
}

class DiscordBridgeConfigLimits {
    public roomGhostJoinDelay: number = 6000;
    public discordSendDelay: number = 1500;
    public roomCount: number = -1;
}

export class LoggingFile {
    public file: string;
    public level: string = "info";
    public maxFiles: string = "14d";
    public maxSize: string|number = "50m";
    public datePattern: string = "YYYY-MM-DD";
    public enabled: string[] = [];
    public disabled: string[] = [];
}

class DiscordBridgeConfigGhosts {
    public nickPattern: string = ":nick";
    public usernamePattern: string = ":username#:tag";
}

export class DiscordBridgeConfigMetrics {
    public enable: boolean = false;
    public port: number = 9001;
    public host: string = "127.0.0.1";
}
