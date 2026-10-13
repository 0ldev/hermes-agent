// THE ui kit re-exports: every control and chrome piece a plugin surface
// wears, so it reads as the app rather than an approximation of it.
export { Badge } from '@/components/ui/badge'
export { Button } from '@/components/ui/button'
/** A tone-washed advisory block. Unlike `Alert` it takes an arbitrary colour,
 *  so it can wear a tone the data already picked. */
export { Callout } from '@/components/ui/callout'
export { Checkbox } from '@/components/ui/checkbox'
export { Codicon } from '@/components/ui/codicon'
/** THE color picker — swatch grid plus a clear row that means "back to the
 *  deterministic color". Feed it `PROFILE_SWATCHES` so a hand-picked color
 *  shares the generated palette's saturation and lightness; a bespoke grid of
 *  literal hex drifts off-theme the moment the palette moves. */
export { ColorSwatches } from '@/components/ui/color-swatches'
export { ConfirmDialog } from '@/components/ui/confirm-dialog'
export {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  // Submenus: Bot Mode files a bot into a user section from its row menu, and
  // a flat list of every folder would swamp the items already there.
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
/** The form-control chrome Input/Textarea/SelectTrigger share — for the
 *  composite controls (steppers, tag fields) the kit doesn't ship. */
export { type ControlVariantProps, controlVariants } from '@/components/ui/control'
export { CopyButton } from '@/components/ui/copy-button'
export { DecodeText } from '@/components/ui/decode-text'
export {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
/** The caret every collapsible section in core uses — points right when closed
 *  and rotates down when open, so the motion matches the rest of the app. Swap
 *  a hand-written `chevron-down`/`chevron-right` ternary for this. */
export { DisclosureCaret } from '@/components/ui/disclosure-caret'
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
export { EmptyState } from '@/components/ui/empty-state'
export { ErrorState } from '@/components/ui/error-state'
export { FadeScroll } from '@/components/ui/fade-scroll'
/** The app's one field language — a label stacked over its control, hint or
 *  `status` underneath. Don't hand-roll a label+control stack; both bundled
 *  plugins did, and the two of them plus this made three. Don't hand-roll the
 *  error line either: `status` puts it under the control and marks the control
 *  invalid, and `FieldStatusSlot` does the same for a control that isn't in a
 *  `Field` or a `SidePanelMetaRow`. */
export {
  Field,
  FIELD_LABEL,
  FIELD_STACK,
  FieldHint,
  type FieldStatus,
  FieldStatusSlot,
  useFieldControl
} from '@/components/ui/field'
export { GlyphSpinner, type SpinnerName } from '@/components/ui/glyph-spinner'
export { Input } from '@/components/ui/input'
export { Kbd, KbdGroup } from '@/components/ui/kbd'
/** The app's canonical loader (animated curves; `lemniscate-bloom` for long
 *  page loads) — the same one every core page uses. */
export { Loader, type LoaderType } from '@/components/ui/loader'
export { LogView } from '@/components/ui/log-view'
/** The chrome a full-page surface is built from — shell, header, title, count,
 *  actions. Both bundled plugin pages wear it, so two plugins read as two
 *  pages of one app rather than two apps. */
export { PageHeader, PageHeaderActions, PageHeaderCount, PageHeaderTitle, PageShell } from '@/components/ui/page-shell'
export { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
/** Full-row / region click target. Imposes NO styling — the caller keeps its own
 *  layout classes — it just bakes in `type="button"` and a stable `data-slot`.
 *  Use it for rows and regions; `Button` is for ordinary compact actions. */
export { RowButton } from '@/components/ui/row-button'
/** The sanctioned embed primitive for external web content: a sandboxed
 *  iframe (opaque origin, `allow-scripts` by default) — never a raw
 *  `<webview>`, which would land on the app's own preview partition. */
export { SandboxedFrame, type SandboxedFrameProps } from '@/components/ui/sandboxed-frame'
export { ScrollArea } from '@/components/ui/scroll-area'
export { SearchField } from '@/components/ui/search-field'
export { SegmentedControl } from '@/components/ui/segmented-control'
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
export { Separator } from '@/components/ui/separator'
/** The detail panel pinned to the edge of a page — non-modal, so the surface
 *  behind it stays live. NOT `Sheet`, which is a portalled modal dialog. */
export {
  SIDE_PANEL_LABEL,
  SIDE_PANEL_TITLE,
  SidePanel,
  SidePanelAction,
  SidePanelBody,
  SidePanelClose,
  SidePanelHeader,
  SidePanelMeta,
  SidePanelMetaRow,
  type SidePanelProps,
  SidePanelSection,
  SidePanelTitle,
  SidePanelTitleInput,
  SidePanelToolbar
} from '@/components/ui/side-panel'
export { Skeleton } from '@/components/ui/skeleton'
/** A bounded number with − / + nudges. */
export { Stepper } from '@/components/ui/stepper'
export { Switch } from '@/components/ui/switch'
export { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
export { TextTab, TextTabMeta } from '@/components/ui/text-tab'
export { Textarea } from '@/components/ui/textarea'
export { Tip, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
