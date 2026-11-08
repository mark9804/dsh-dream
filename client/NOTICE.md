# Dream settings controls

Switch, radio group, and collapsible source in `shadcn.tsx` is adapted from the official shadcn/ui **Base UI** registry (not Radix), read on 2026-11-06. Source revision inspected: `c257f688cf4de7ec10cc1be84cad29cd4631182c` (switch's last change; source files fetched from main). Full MIT license retained in `SHADCN_LICENSE.txt` and the built third-party notices.

Sources:
- https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/bases/base/ui/switch.tsx
- https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/bases/base/ui/radio-group.tsx
- https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/bases/base/ui/collapsible.tsx

Changes: replaced cn/Tailwind classes with plugin-scoped, Host-token CSS; retained primitive composition, namespaced the Switch data-slot identifiers to avoid Host-wide selector collisions, and rendered its root as an explicitly reset native button. React is external and overlay containers stay inside the plugin. The remaining Field / FieldSet / Input Group / choice-card layout, combobox wrappers and CSS are original source following the shadcn compositional approach. No Radix primitives or Harness-private Client components are imported.

Interactive behavior is provided by **Base UI** (`@base-ui/react`), an MIT-licensed project maintained by the MUI/Base UI contributors. Its distributed license must remain in the dependency/package attribution produced by the build. React and ReactDOM are supplied by the Harness browser module loader and must not be bundled a second time.

Reference APIs inspected for implementation:

- https://base-ui.com/react/components/combobox
- https://base-ui.com/react/components/switch
- https://base-ui.com/react/components/alert-dialog
- https://ui.shadcn.com/docs/components/field

All visible application copy is owned by the `dsh-dream-settings` locale namespace, with complete Chinese and English dictionaries. No component injects a global stylesheet or modifies the Host theme. Portals are attached to the plugin's scoped React container.
