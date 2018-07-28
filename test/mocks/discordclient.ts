import {MockCollection} from "./collection";
import {MockGuild} from "./guild";
import {MockUser} from "./user";

export class MockDiscordClient {
  public guilds = new MockCollection<string, MockGuild>();
  public user: MockUser;
  private testLoggedIn: boolean = false;
  private testCallbacks: Map<string, () => void> = new Map();

  constructor() {
    const channels = [
      {
        id: "321",
        name: "achannel",
        type: "text",
      }, {
        id: "654",
        name: "a-channel",
        type: "text",
      }, {
        id: "987",
        name: "a channel",
        type: "text",
      },
    ];
    this.guilds.set("123", new MockGuild("MyGuild", channels));
    this.guilds.set("456", new MockGuild("My Spaces Gui", channels));
    this.guilds.set("789", new MockGuild("My Dash-Guild", channels));
    this.user = new MockUser("12345");
  }

  public on(event: string, callback: () => void) {
      this.testCallbacks.set(event, callback);
  }

  public async login(token: string): Promise<void> {
    if (token !== "passme") {
        throw new Error("Mock Discord Client only logins with the token 'passme'");
    }
    this.testLoggedIn = true;
    if (this.testCallbacks.has("ready")) {
        this.testCallbacks.get("ready")();
    }
    return;
  }

  public destroy() { } // no-op
}
