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

import { expect } from "chai";
import * as Proxyquire from "proxyquire";

let createdLogger: any = null;
let loggedMessages: any[] = [];

const WinstonMock = {
    createLogger: (format, transports) => {
        return createdLogger = {
            close: (): void => { },
            format,
            log: (type, ...msg) => {
                loggedMessages = loggedMessages.concat(msg);
            },
            silent: false,
            transports,
        };
    },
};

const Log = (Proxyquire("../src/log", {
    winston: WinstonMock,
}).Log);

describe("Log", () => {

    beforeEach(() => {
        loggedMessages = [];
    });

    describe("Configure", () => {
        it("should pass if config is empty", () => {
            Log.Configure({});
        });
        it("should set basic log options", () => {
            Log.Configure({
                console: "warn",
                lineDateFormat: "HH:mm:ss",
            });
            expect(Log.config.console).to.equal("warn");
            expect(Log.config.lineDateFormat).to.equal("HH:mm:ss");
            expect(Log.config.files).to.be.empty;
        });
        it("should setup file logging", () => {
            Log.Configure({
                files: [
                    {
                        file: "./logfile.log",
                    },
                ],
            });
            expect(Log.config.files).to.not.be.empty;
            expect(Log.config.files[0].file).to.equal("./logfile.log");
        });
        it("should warn if log level got misspelled", () => {
            Log.Configure({
                console: "WARNING",
                lineDateFormat: "HH:mm:ss",
            });
            expect(loggedMessages).to.contain("Console log level is invalid. Please pick one of the case-sensitive levels provided in the sample config.");
        });
        it("should warn if log level for a file got misspelled", () => {
            Log.Configure({
                files: [
                    {
                        file: "./logfile.log",
                        level: "WARNING",
                    },
                ],
            });
            expect(loggedMessages).to.contain("Log level of ./logfile.log is invalid. Please pick one of the case-sensitive levels provided in the sample config.");
        });
    });
    describe("ForceSilent", () => {
        it("should be silent", () => {
            Log.ForceSilent();
            expect(createdLogger.silent).to.be.true;
            expect(loggedMessages).to.contain("Log set to silent");
        });
    });
    describe("instance", () => {
        it("should log without configuring", () => {
            new Log("test").info("hi");
            expect(loggedMessages).to.contain("hi");
        });
    });
});
