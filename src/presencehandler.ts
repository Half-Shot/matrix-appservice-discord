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

import { User, Presence } from "better-discord.js";
import { DiscordBot } from "./bot";
import { Log } from "./log";
import { MetricPeg } from "./metrics";
const log = new Log("PresenceHandler");

export class PresenceHandlerStatus {
    public Presence: "online"|"offline"|"unavailable";
    public StatusMsg: string;
    public ShouldDrop: boolean = false;
}

export class PresenceHandler {
    private presenceQueue: Presence[];
    private interval: NodeJS.Timeout | null;
    constructor(private bot: DiscordBot) {
        this.presenceQueue = [];
    }

    get QueueCount(): number {
        return this.presenceQueue.length;
    }

    public async Start(intervalTime: number) {
        if (this.interval) {
            log.info("Restarting presence handler...");
            this.Stop();
        }
        log.info(`Starting presence handler with new interval ${intervalTime}ms`);
        this.interval = setInterval(await this.processIntervalThread.bind(this),
            intervalTime);
    }

    public Stop() {
        if (!this.interval) {
            log.info("Can not stop interval, not running.");
            return;
        }
        log.info("Stopping presence handler");
        clearInterval(this.interval);
        this.interval = null;
    }

    public EnqueueUser(presence: Presence) {
        if (presence.userID === this.bot.GetBotId()) {
            return;
        }

        // Delete stale presence
        const indexOfPresence = this.presenceQueue.findIndex((u) => u.userID === presence.userID);
        if (indexOfPresence !== -1) {
            this.presenceQueue.splice(indexOfPresence, 1);
        }
        log.verbose(`Adding ${presence.userID} (${presence.user?.username}) to the presence queue`);
        this.presenceQueue.push(presence);
        MetricPeg.get.setPresenceCount(this.presenceQueue.length);
    }

    public DequeueUser(user: User) {
        const index = this.presenceQueue.findIndex((item) => {
            return user.id === item.userID;
        });
        if (index !== -1) {
            this.presenceQueue.splice(index, 1);
            MetricPeg.get.setPresenceCount(this.presenceQueue.length);
        } else {
            log.warn(
                `Tried to remove ${user.id} from the presence queue but it could not be found`,
            );
        }
    }

    public async ProcessUser(presence: Presence): Promise<boolean> {
        if (!presence.user) {
            return true;
        }
        const status = this.getUserPresence(presence);
        await this.setMatrixPresence(presence.user, status);
        return status.ShouldDrop;
    }

    private async processIntervalThread() {
        const presence = this.presenceQueue.shift();
        if (presence) {
            const proccessed = await this.ProcessUser(presence);
            if (!proccessed) {
                this.presenceQueue.push(presence);
            } else {
                log.verbose(`Dropping ${presence.userID} from the presence queue.`);
                MetricPeg.get.setPresenceCount(this.presenceQueue.length);
            }
        }
    }

    private getUserPresence(presence: Presence): PresenceHandlerStatus {
        const status = new PresenceHandlerStatus();

        // How do we show multiple activities?
        const activity = presence.activities[0];
        if (activity) {
            const type = activity.type[0] + activity.type.substring(1).toLowerCase(); // STREAMING -> Streaming;
            status.StatusMsg = `${type} ${activity.name}`;
            if (activity.url) {
                status.StatusMsg += ` | ${activity.url}`;
            }
        }

        if (presence.status === "online") {
            status.Presence = "online";
        } else if (presence.status === "dnd") {
            status.Presence = "online";
            status.StatusMsg = status.StatusMsg ? `Do not disturb | ${status.StatusMsg}` : "Do not disturb";
        } else if (presence.status === "offline") {
            status.Presence = "offline";
            status.ShouldDrop = true; // Drop until we recieve an update.
        } else { // idle
            status.Presence = "unavailable";
        }
        return status;
    }

    private async setMatrixPresence(user: User, status: PresenceHandlerStatus) {
        const intent = this.bot.GetIntentFromDiscordMember(user);
        try {
            await intent.ensureRegistered();
            await intent.underlyingClient.setPresenceStatus(status.Presence, status.StatusMsg || "");
        } catch (ex) {
            if (ex.errcode !== "M_FORBIDDEN") {
                log.warn(`Could not update Matrix presence for ${user.id}`);
                return;
            }
            try {
                await this.bot.UserSyncroniser.OnUpdateUser(user);
            } catch (err) {
                log.warn(`Could not register new Matrix user for ${user.id}`);
            }
        }
    }
}
