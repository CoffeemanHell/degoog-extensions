# degoog-extensions

A [degoog](https://degoog-org.github.io/docs/index.html) Store repository.

| Extension | What it does |
| --- | --- |
| [EmuCompat](plugins/emu-compat/README.md) | Cards for PS2 / PS3 / PS4 title IDs and the `!emu` name search |

## Install

In degoog open Settings, then Store, then Add, and paste this repository's clone URL.
`package.json` lists what the Store shows; bump an extension's `version` there when users should update.

## Develop

```bash
bun test
```

No dependencies. The tests run the plugin against a fake `fetch`, so they need no network.

## Credits

Substantially inspired by [EthanC/degoog-extensions](https://github.com/EthanC/degoog-extensions) (AGPL-3.0).

## License

[AGPL-3.0](LICENSE)
