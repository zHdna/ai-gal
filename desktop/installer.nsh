; AI-GAL 桌面版 —— NSIS 卸载附加脚本
;
; 背景：electron-builder 的标准卸载流程会在 uninstaller.nsh:169 执行
; `RMDir /r $INSTDIR`，但此时卸载器自身还在 $INSTDIR 里运行，目录无法被删掉，
; 结果卸载后会残留一个**空文件夹**（文件、快捷方式、注册表项都已清理干净）。
;
; 这里挂在 customUnInstall 宏上 —— 它在卸载段的最后一步执行（此时文件已全部移除），
; 补删一次空目录。刻意用不带 /r 的 RMDir：它**只能删除空目录**，
; 即使有人把安装目录选成了 D:\ 这种位置，也绝不会误删其中任何内容。
;
; 另加 SetOutPath $TEMP：把卸载器的当前工作目录挪走，避免「目录正被占用」导致删除失败。

!macro customUnInstall
  SetOutPath "$TEMP"
  RMDir "$INSTDIR"
!macroend
