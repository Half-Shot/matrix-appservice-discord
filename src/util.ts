/*
Copyright 2018, 2019 matrix-appservice-discord

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

import * as http from "http";
import * as https from "https";
import { Buffer } from "buffer";
import { Permissions } from "better-discord.js";
import { DiscordBridgeConfig } from "./config";
import { IMatrixEvent } from "./matrixtypes";

const HTTP_OK = 200;

import { Log } from "./log";
import { Intent, MatrixClient } from "matrix-bot-sdk";
const log = new Log("Util");

type PERMISSIONTYPES = any | any[]; // tslint:disable-line no-any

export interface ICommandAction {
    description?: string;
    help?: string;
    params: string[];
    permission?: PERMISSIONTYPES;
    run(params: any): Promise<any>; // tslint:disable-line no-any
}

export interface ICommandActions {
    [index: string]: ICommandAction;
}

export interface ICommandParameter {
    description?: string;
    get?(param: string): Promise<any>; // tslint:disable-line no-any
}

export interface ICommandParameters {
    [index: string]: ICommandParameter;
}

export type CommandPermissonCheck = (permission: PERMISSIONTYPES) => Promise<boolean | string>;

export interface IDownloadedFile {
    buffer: Buffer;
    mimeType?: string;
}

export interface IPatternMap {
    [index: string]: string;
}

export class Util {
    /**
     * downloadFile - This function will take a URL and store the resulting data into
     * a buffer.
     */
    public static async DownloadFile(url: string): Promise<IDownloadedFile> {
        return new Promise((resolve, reject) => {
            let get = http.get;
            if (url.startsWith("https")) {
                get = https.get;
            }
            const req = get((url), (res) => {
                let buffer = Buffer.alloc(0);
                if (res.statusCode !== HTTP_OK) {
                    reject(`Non 200 status code (${res.statusCode})`);
                }

                res.on("data", (d) => {
                    buffer = Buffer.concat([buffer, d]);
                });

                res.on("end", () => {
                    resolve({
                        buffer,
                        mimeType: res.headers["content-type"],
                    });
                });
            });
            req.on("error", (err) => {
                reject(`Failed to download. ${err}`);
            });
        }) as Promise<IDownloadedFile>;
    }

    /**
     * Gets a promise that will resolve after the given number of milliseconds
     * @param {number} duration The number of milliseconds to wait
     * @returns {Promise<any>} The promise
     */
    public static async DelayedPromise(duration: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            setTimeout(resolve, duration);
        });
    }

    public static GetBotLink(config: DiscordBridgeConfig): string {
        /* tslint:disable:no-bitwise */
        const perms = Permissions.FLAGS.SEND_MESSAGES! |
            Permissions.FLAGS.CHANGE_NICKNAME! |
            Permissions.FLAGS.CONNECT! |
            Permissions.FLAGS.SPEAK! |
            Permissions.FLAGS.EMBED_LINKS! |
            Permissions.FLAGS.ATTACH_FILES! |
            Permissions.FLAGS.READ_MESSAGE_HISTORY! |
            Permissions.FLAGS.MANAGE_WEBHOOKS! |
            Permissions.FLAGS.MANAGE_MESSAGES!;
        /* tslint:enable:no-bitwise */

        const clientId = config.auth.clientID;

        return `https://discord.com/api/oauth2/authorize?client_id=${clientId}&scope=bot&permissions=${perms}`;
    }

    public static async GetMxidFromName(intent: Intent, name: string, channelMxids: string[]) {
        if (name[0] === "@" && name.includes(":")) {
            return name;
        }
        const client = intent.underlyingClient;
        await intent.ensureRegistered();
        const matrixUsers = {};
        let matches = 0;
        await Promise.all(channelMxids.map( async (chan) => {
            (await client.getRoomMembers(chan, undefined, ["leave"])).forEach((member) => {
                if (member.membership === "invite") {
                    return;
                }
                const mxid = member.stateKey;
                if (mxid.startsWith("@_discord_")) {
                    return;
                }
                let displayName = member.content.displayname;
                if (!displayName && member.previousContent.displayname) {
                    displayName = member.previousContent.displayname;
                }
                if (!displayName) {
                    displayName = mxid.substring(1, mxid.indexOf(":"));
                }
                if (name.toLowerCase() === displayName.toLowerCase() || name === mxid) {
                    matrixUsers[mxid] = displayName;
                    matches++;
                }
            });
        }));
        if (matches === 0) {
            throw Error(`No users matching ${name} found`);
        }
        if (matches > 1) {
            let errStr = "Multiple matching users found:\n";
            for (const mxid of Object.keys(matrixUsers)) {
                errStr += `${matrixUsers[mxid]} (\`${mxid}\`)\n`;
            }
            throw Error(errStr);
        }
        return Object.keys(matrixUsers)[0];
    }

    public static async HandleHelpCommand(
        prefix: string,
        actions: ICommandActions,
        parameters: ICommandParameters,
        args: string[],
        permissionCheck?: CommandPermissonCheck,
    ): Promise<string> {
        let reply = "";
        if (args[0]) {
            const actionKey = args[0];
            const action = actions[actionKey];
            if (!actions[actionKey]) {
                return `**ERROR:** unknown command! Try \`${prefix} help\` to see all commands`;
            }
            if (action.permission !== undefined && permissionCheck) {
                const permCheck = await permissionCheck(action.permission);
                if (typeof permCheck === "string") {
                    return `**ERROR:** ${permCheck}`;
                }
                if (!permCheck) {
                    return `**ERROR:** permission denied! Try \`${prefix} help\` to see all available commands`;
                }
            }
            reply += `\`${prefix} ${actionKey}`;
            for (const param of action.params) {
                reply += ` <${param}>`;
            }
            reply += `\`: ${action.description}\n`;
            if (action.help) {
                reply += action.help;
            }
            return reply;
        }
        if (Object.keys(actions).length === 0) {
            return "No commands found";
        }
        reply += "Available Commands:\n";
        let commandsHavePermission = 0;
        for (const actionKey of Object.keys(actions)) {
            const action = actions[actionKey];
            if (action.permission !== undefined && permissionCheck) {
                const permCheck = await permissionCheck(action.permission);
                if (typeof permCheck === "string" || !permCheck) {
                    continue;
                }
            }
            commandsHavePermission++;
            reply += ` - \`${prefix} ${actionKey}`;
            for (const param of action.params) {
                reply += ` <${param}>`;
            }
            reply += `\`: ${action.description}\n`;
        }
        if (!commandsHavePermission) {
            return "No commands found";
        }
        reply += "\nParameters:\n";
        for (const parameterKey of Object.keys(parameters)) {
            const parameter = parameters[parameterKey];
            reply += ` - \`<${parameterKey}>\`: ${parameter.description}\n`;
        }
        return reply;
    }

    public static async ParseCommand(
        prefix: string,
        msg: string,
        actions: ICommandActions,
        parameters: ICommandParameters,
        permissionCheck?: CommandPermissonCheck,
    ): Promise<string> {
        const {command, args} = Util.MsgToArgs(msg, prefix);
        if (command === "help") {
            return await Util.HandleHelpCommand(prefix, actions, parameters, args, permissionCheck);
        }

        if (!actions[command]) {
            return `**ERROR:** unknown command. Try \`${prefix} help\` to see all commands`;
        }
        const action = actions[command];
        if (action.permission !== undefined && permissionCheck) {
            const permCheck = await permissionCheck(action.permission);
            if (typeof permCheck === "string") {
                return `**ERROR:** ${permCheck}`;
            }
            if (!permCheck) {
                return `**ERROR:** insufficient permissions to use this command! ` +
                    `Try \`${prefix} help\` to see all available commands`;
            }
        }
        if (action.params.length === 1) {
            args[0] = args.join(" ");
        }
        try {
            const params = {};
            let i = 0;
            for (const param of action.params) {
                if (parameters[param].get !== undefined) {
                    params[param] = await parameters[param].get!(args[i]);
                } else {
                    params[param] = args[i];
                }
                i++;
            }

            const retStr = await action.run(params);
            return retStr;
        } catch (e) {
            log.error("Error processing command");
            log.error(e);
            return `**ERROR:** ${e.message}`;
        }
    }

    public static MsgToArgs(msg: string, prefix: string) {
        prefix += " ";
        let command = "help";
        let args: string[] = [];
        if (msg.length >= prefix.length) {
            const allArgs = msg.substring(prefix.length).split(" ");
            if (allArgs.length && allArgs[0] !== "") {
                command = allArgs[0];
                allArgs.splice(0, 1);
                args = allArgs;
            }
        }
        return {command, args};
    }

    public static async AsyncForEach<T>(arr: T[], callback: (item: T, i: number, a: T[]) => Promise<void>) {
        for (let i = 0; i < arr.length; i++) {
            await callback(arr[i], i, arr);
        }
    }

    public static NumberToHTMLColor(color: number): string {
        const HEX_BASE = 16;
        const COLOR_MAX = 0xFFFFFF;
        if (color > COLOR_MAX) {
            color = COLOR_MAX;
        }
        if (color < 0) {
            color = 0;
        }
        const colorHex = color.toString(HEX_BASE);
        const pad = "#000000";
        const htmlColor = pad.substring(0, pad.length - colorHex.length) + colorHex;
        return htmlColor;
    }

    public static ApplyPatternString(str: string, patternMap: IPatternMap): string {
        for (const p of Object.keys(patternMap)) {
            str = str.replace(new RegExp(":" + p, "g"), patternMap[p]);
        }
        return str;
    }

    public static async CheckMatrixPermission(
        mxClient: MatrixClient,
        userId: string,
        roomId: string,
        defaultLevel: number,
        cat: string,
        subcat?: string,
    ) {
        const res: IMatrixEvent = await mxClient.getRoomStateEvent(roomId, "m.room.power_levels", "");
        let requiredLevel = defaultLevel;
        if (res && (res[cat] || !subcat)) {
            if (subcat) {
                if (res[cat][subcat] !== undefined) {
                    requiredLevel = res[cat][subcat];
                }
            } else {
                if (res[cat] !== undefined) {
                    requiredLevel = res[cat];
                }
            }
        }

        let haveLevel = 0;
        if (res && res.users_default) {
            haveLevel = res.users_default;
        }
        if (res && res.users && typeof res.users[userId] === "number") {
            haveLevel = res.users[userId];
        }
        return haveLevel >= requiredLevel;
    }

    public static ParseMxid(unescapedMxid: string, escape: boolean = true) {
        const RADIX = 16;
        const parts = unescapedMxid.substring(1).split(":");
        const domain = parts[1];
        let localpart = parts[0];
        if (escape) {
            const badChars = new Set(localpart.replace(/([a-z0-9]|-|\.|=|_)+/g, ""));
            badChars.forEach((c) => {
                const hex = c.charCodeAt(0).toString(RADIX).toLowerCase();
                localpart = localpart.replace(
                    new RegExp(`\\${c}`, "g"),
                    `=${hex}`,
                );
            });
        }
        return {
            domain,
            localpart,
            mxid: `@${localpart}:${domain}`,
        };
    }

    // Taken from https://github.com/matrix-org/matrix-appservice-bridge/blob/master/lib/models/users/matrix.js
    public static EscapeStringForUserId(localpart: string) {
        // NOTE: Currently Matrix accepts / in the userId, although going forward it will be removed.
        const badChars = new Set(localpart.replace(/([a-z]|[0-9]|-|\.|=|_)+/g, ""));
        let res = localpart;
        badChars.forEach((c) => {
            const hex = c.charCodeAt(0).toString(16).toLowerCase();
            res = res.replace(
                new RegExp(`\\x${hex}`, "g"),
                `=${hex}`,
            );
        });
        return res;
    }
}

// Type type
type Type = Function;  // tslint:disable-line ban-types

/**
 * Returns true if `obj` is subtype of at least one of the given types.
 */
export function isInstanceOfTypes(obj: object, types: Type[]): boolean {
    return types.some((type) => obj instanceof type);
}

/**
 * Append the old error message to the new one and keep its stack trace.
 *
 * @example
 * throw wrapError(e, HighLevelError, "This error is more specific");
 *
 * @param oldError The original error to wrap.
 * @param newErrorType Type of the error returned by this function.
 * @returns A new error of type `newErrorType` containing the information of
 * the original error (stacktrace and error message).
 */
export function wrapError<T extends Error>(
    oldError: object|Error,
    newErrorType: new (...args: any[]) => T,  // tslint:disable-line no-any
    ...args: any[]  // tslint:disable-line no-any trailing-comma
): T {
    const newError = new newErrorType(...args);
    let appendMsg;
    if (oldError instanceof Error) {
        appendMsg = oldError.message;
        newError.stack = oldError.stack;
    } else {
        appendMsg = oldError.toString();
    }
    newError.message += ":\n" + appendMsg;
    return newError;
}
