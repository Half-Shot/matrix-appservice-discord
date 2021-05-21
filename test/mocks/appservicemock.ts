import { IMatrixEvent } from "../../src/matrixtypes";
import { expect } from "chai";
interface IAppserviceMockOpts {
    roommembers?: IMatrixEvent[];
    stateEventFetcher?: (roomId, stateType, stateKey) => Promise<any>;
    eventFetcher?: (roomId, eventId) => Promise<any>;
    profileFetcher?: (userId) => Promise<any>;
    botUserId?: string;
    userIdPrefix?: string;
    aliasPrefix?: string;
    joinedrooms?: string[];
    homeserverName?: string;
}

class AppserviceMockBase {
    private calls: {[key: string]: [any[]]} = {};

    public wasCalled(funcName: string, throwOnMissing: boolean = true, ...args: any[]): number {
        const called = this.calls[funcName];
        if (!called && throwOnMissing) {
            throw Error(`${funcName} was not called`);
        } else if (!called) {
            return 0;
        } else if (args.length === 0) {
            return called.length;
        }
        const calls = called.filter((callArgs) => {
            try {
                expect(callArgs).to.deep.equal(args);
                return true;
            } catch {
                return false;
            }
        }).length;
        if (calls === 0 && throwOnMissing) {
            let msg = `${funcName} was not called with the correct parameters`;
            if (called.length) {
                msg += `. Calls that were made:\n${JSON.stringify(called, undefined, 2)}`;
            }
            throw Error(msg);
        }
        return calls;
    }

    public wasNotCalled(funcName: string, throwOnFound: boolean = true, ...args: any[]): boolean {
        if (this.wasCalled(funcName, false, args)) {
            if (throwOnFound) {
                throw Error(`${funcName} was called`);
            }
            return false;
        }
        return true;
    }

    protected funcCalled(funcName: string, ...args: any[]): void {
        this.calls[funcName] = this.calls[funcName] || [];
        this.calls[funcName].push(args);
    }
}

export class AppserviceMock extends AppserviceMockBase {
    public botIntent: IntentMock;
    public botClient: MatrixClientMock;
    public intents: {[id: string]: IntentMock};

    public get botUserId(): string {
        return this.opts.botUserId || "@bot:localhost";
    }

    constructor(private opts: IAppserviceMockOpts = {}) {
        super();
        opts.roommembers = opts.roommembers || [];
        this.cleanup();
    }

    public cleanup(): void {
        this.intents = {};
        this.botIntent = new IntentMock(this.opts, "BOT");
        this.botClient = this.botIntent.underlyingClient;
    }

    public isNamespacedUser(userId: string): boolean {
        this.funcCalled("isNamespacedUser", userId);
        if (this.opts.userIdPrefix) {
            return userId.startsWith(this.opts.userIdPrefix);
        }
        throw Error("No prefix defined");
    }

    public isNamespacedAlias(alias: string): boolean {
        this.funcCalled("isNamespacedAlias", alias);
        if (this.opts.aliasPrefix) {
            return alias.startsWith(this.opts.aliasPrefix);
        }
        throw Error("No prefix defined");
    }

    public getIntent(userId: string): IntentMock {
        this.funcCalled("getIntent", userId);
        if (!this.intents[userId]) {
            this.intents[userId] = new IntentMock(this.opts, userId);
        }
        return this.intents[userId];
    }

    public getIntentForSuffix(suffix: string): IntentMock {
        this.funcCalled("getIntentForSuffix", suffix);
        if (!this.intents[suffix]) {
            this.intents[suffix] = new IntentMock(this.opts, suffix);
        }
        return this.intents[suffix];
    }

    public getAliasForSuffix(suffix: string): string {
        this.funcCalled("getAliasForSuffix", suffix);
        if (this.opts.aliasPrefix) {
            return `${this.opts.aliasPrefix}${suffix}:${this.opts.homeserverName}`;
        }
        throw Error("No prefix defined");
    }

    public getIntentForUserId(userId: string): IntentMock {
        this.funcCalled("getIntentForUserId", userId);
        if (!this.intents[userId]) {
            this.intents[userId] = new IntentMock(this.opts, userId);
        }
        return this.intents[userId];
    }

    public getSuffixForUserId(userId: string): string {
        this.funcCalled("getSuffixForUserId", userId);
        const localpart = userId.split(":")[0];
        if (this.opts.userIdPrefix) {
            return localpart.replace(this.opts.userIdPrefix!, "");
        }
        throw Error("No prefix defined");
    }

    public async setRoomDirectoryVisibility(roomId: string, vis: string): Promise<void> {
        this.funcCalled("setRoomDirectoryVisibility", roomId, vis);
    }
}

class IntentMock extends AppserviceMockBase {
    public readonly underlyingClient: MatrixClientMock;
    constructor(private opts: IAppserviceMockOpts = {}, private id: string) {
        super();
        this.underlyingClient = new MatrixClientMock(opts);
    }

    public join(): void {
        this.funcCalled("join");
    }

    public joinRoom(roomIdOrAlias: string): void {
        this.funcCalled("joinRoom", roomIdOrAlias);
    }

    public leave(roomIdOrAlias: string): void {
        this.funcCalled("leave", roomIdOrAlias);
    }

    public sendText(roomId: string, body: string): void {
        this.funcCalled("sendText", roomId, body);
    }

    public sendEvent(roomId: string, content: any): void {
        this.funcCalled("sendEvent", roomId, content);
    }

    public async ensureRegistered(): Promise<void> {
        this.funcCalled("ensureRegistered");
    }
}

class MatrixClientMock extends AppserviceMockBase {

    constructor(private opts: IAppserviceMockOpts = {}) {
        super();
    }

    public banUser(roomId: string, userId: string): void {
        this.funcCalled("banUser", roomId, userId);
    }

    public sendMessage(roomId: string, eventContent: IMatrixEvent): void {
        this.funcCalled("sendMessage", roomId, eventContent);
    }

    public sendEvent(roomId: string, body: string, msgtype: string): void {
        this.funcCalled("sendEvent", roomId, body, msgtype);
    }

    public getRoomMembers(roomId: string): IMatrixEvent[] {
        this.funcCalled("getRoomMembers", roomId);
        if (!this.opts.roommembers) {
            throw Error("No roommembers defined");
        }
        return this.opts.roommembers;
    }

    public getJoinedRooms(): string[] {
        this.funcCalled("getJoinedRooms");
        if (!this.opts.joinedrooms) {
            throw Error("No joinedrooms defined");
        }
        return this.opts.joinedrooms;
    }

    public leaveRoom(roomId: string): void {
        this.funcCalled("leaveRoom", roomId);
    }

    public kickUser(roomId: string, userId: string): void {
        this.funcCalled("kickUser", roomId, userId);
    }

    public sendStateEvent(roomId: string, type: string, stateKey: string, content: Record<string, unknown>): void {
        this.funcCalled("sendStateEvent", roomId, type, stateKey, content);
    }

    public setAvatarUrl(avatarUrl: string): void {
        this.funcCalled("setAvatarUrl", avatarUrl);
    }

    public setDisplayName(displayName: string): void {
        this.funcCalled("setDisplayName", displayName);
    }

    public async getUserProfile(userId: string) {
        this.funcCalled("getUserProfile", userId);
        if (this.opts.profileFetcher) {
            return await this.opts.profileFetcher(userId);
        }
        throw Error("No stateEventFetcher defined");
    }

    public async uploadContent(data: Buffer, contentType: string, filename: string = "noname") {
        this.funcCalled("uploadContent", data, contentType, filename);
        return `mxc://${filename}`;
    }

    public mxcToHttp(mxcUrl: string) {
        this.funcCalled("mxcToHttp", mxcUrl);
        return mxcUrl.replace("mxc://", "https://");
    }

    public mxcToHttpThumbnail(mxcUrl: string) {
        this.funcCalled("mxcToHttpThumbnail", mxcUrl);
        return mxcUrl.replace("mxc://", "https://");
    }

    public async getRoomStateEvent(roomId: string, type: string, stateKey: string): Promise<any> {
        this.funcCalled("getRoomStateEvent", roomId, type, stateKey);
        if (this.opts.stateEventFetcher) {
            return await this.opts.stateEventFetcher(roomId, type, stateKey);
        }
        throw Error("No stateEventFetcher defined");
    }

    public async getEvent(roomId: string, eventId: string): Promise<any> {
        this.funcCalled("getEvent", roomId, eventId);
        if (this.opts.eventFetcher) {
            return await this.opts.eventFetcher(roomId, eventId);
        }
        throw Error("No getEvent defined");
    }

    public unbanUser(roomId: string, userId: string) {
        this.funcCalled("unbanUser", roomId, userId);
    }

    public async setPresenceStatus(presence: string, status: string) {
        this.funcCalled("setPresenceStatus", presence, status);
    }
}
