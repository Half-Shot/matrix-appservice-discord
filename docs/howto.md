
### Join a room

The default format for room aliases (which are automatically resolved, whether the room exists on Matrix or not) is:

``#_discord_guildid_channelid``

You can find these on discord in the browser where:

``https://discord.com/channels/282616294245662720/282616372591329281``

is formatted as https://discord.com/channels/``guildid``/``channelid``

### Set privileges on bridge managed rooms

* The ``adminme`` script is provided to set Admin/Moderator or any other custom power level to a specific user.
* e.g. To set Alice to Admin on her ``example.com`` HS on default config. (``config.yaml``)
  * ``npm run adminme -- -m '!AbcdefghijklmnopqR:example.com' -u '@Alice:example.com' -p '100'``
  * Run ``npm run adminme -- -h`` for usage.

Please note that `!AbcdefghijklmnopqR:example.com` is the internal room id and will always begin with `!`.
You can find this internal id in the room settings in Element.

### Migrate to postgres from sqlite
* Stop the bridge.
* Create a new database on postgres and create a user for it with a password.
    * We will call the database `discord_bridge` and the the user `discord`.
* Install `pgloader` if you do not have it.
* Run `pgloader ./discord.db postgresql://discord:password@localhost/discord_bridge`
* Change the config so that the config contains:

```yaml
database:
    connString: "postgresql://discord:password@localhost/discord_bridge"
```
* All done!
