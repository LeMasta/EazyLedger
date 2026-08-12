# EazyLedger 开发约束

- 所有版本改动必须在独立 `agent/vX.Y.Z` 分支完成，通过草稿 PR 合入 `main`，不得直接修改 `main`。
- 每次更新应用版本号时，必须同步更新 `README.md` 的当前版本、功能说明和必要的使用说明。
- 版本号必须在 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 中保持一致。
- Windows 安装包与更新产物通过 GitHub Actions 发布工作流构建；Release 发布前保留为草稿并完成验收。
- 更新源/CDN 方案当前搁置，除非用户重新明确要求，否则不要修改 updater endpoint 或发布源配置。
