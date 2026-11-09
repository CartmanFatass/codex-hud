# Pi package templates

Placeholder area for the Pi package integration. A5 fills it in.

The release ships ordinary-named files only. Dot-prefixed client metadata (a package
manifest, a settings fragment) lives here under a plain template name; activation
materializes it under its real dot-prefixed name in the client's own directory. The
packer's path and dotfile rules stay strict, so no dotfile ever appears in a release.

The canonical delegation skill is `integrations/skills/hud-delegate/SKILL.md`; this
area does not duplicate it. A template that names a release pins the immutable
release version and the runtime manifest digest, never a branch or a working tree.

Nothing here is active until an activation plan is previewed and applied. See
`docs/reference.md`, "Installing".
