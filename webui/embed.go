// Package webui embeds the static management interface.
package webui

import (
	"embed"
)

// Assets contains the static management interface served by the admin listener.
//
//go:embed index.html app.js i18n.js styles.css
var Assets embed.FS
