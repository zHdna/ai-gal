; AI-GAL 桌面版 —— NSIS 安装 / 卸载附加脚本
;
; electron-builder 以 `-INPUTCHARSET UTF8` 调用 makensis，所以本文件按 UTF-8 保存，
; 中文字符串不会乱码。
;
; ── 1) 「局域网模式」快捷方式 ────────────────────────────────────────────────
; 默认**不开**局域网（只监听 127.0.0.1，仅本机可访问）。把服务开放到局域网有安全
; 代价：同网络内任何人都能打开界面、看到你的 API Key 设置。所以它必须是用户显式
; 选择的结果，而不是默认状态。
;
; 这里提供一个独立快捷方式，等价于 `AI-GAL.exe --lan`：
;   · 刻意只放进「开始菜单」，**不放桌面** —— 桌面只留普通快捷方式，避免误点就把
;     服务暴露到局域网；
;   · 只在本次启动生效，不写入配置，关掉即恢复仅本机访问。
;
; 插入位置见 installSection.nsh:81，在 addStartMenuLink(第 68 行) 之后，
; 所以此时开始菜单目录已存在，$newStartMenuLink 也已指向主快捷方式。
;
; ── 2) 卸载后清理空安装目录 ─────────────────────────────────────────────────
; 标准卸载流程会在 uninstaller.nsh:169 执行 `RMDir /r $INSTDIR`，但那一刻卸载器
; 自身还在 $INSTDIR 里运行，目录删不掉，于是留下一个空文件夹（文件、快捷方式、
; 注册表项其实都已清理干净）。
;
; 挂在 customUnInstall 宏上 —— 它在卸载段的最后一步执行（此时文件已全部移除），
; 补删一次。刻意用不带 /r 的 RMDir：它**只能删除空目录**，即使有人把安装位置选成
; D:\ 这种目录，也绝不会误删其中任何内容。

!define LAN_LINK_NAME "${SHORTCUT_NAME}（局域网模式）"

!macro customInstall
  !ifdef MENU_FILENAME
    CreateShortCut "$SMPROGRAMS\${MENU_FILENAME}\${LAN_LINK_NAME}.lnk" "$appExe" "--lan" "$appExe" 0
    ClearErrors
  !else
    CreateShortCut "$SMPROGRAMS\${LAN_LINK_NAME}.lnk" "$appExe" "--lan" "$appExe" 0
    ClearErrors
  !endif
!macroend

!macro customUnInstall
  ; 删除「局域网模式」快捷方式（切回安装时相同的 shell 上下文）
  ${if} $installMode == "all"
    SetShellVarContext all
  ${else}
    SetShellVarContext current
  ${endif}
  !ifdef MENU_FILENAME
    Delete "$SMPROGRAMS\${MENU_FILENAME}\${LAN_LINK_NAME}.lnk"
  !else
    Delete "$SMPROGRAMS\${LAN_LINK_NAME}.lnk"
  !endif

  ; `--lan` 只是启动参数，不落盘，所以这里没有需要额外清理的配置
  SetOutPath "$TEMP"
  RMDir "$INSTDIR"
!macroend
