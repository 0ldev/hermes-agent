import { Button, Codicon, PageHeader, PageHeaderActions, PageHeaderTitle, Tip } from '@hermes/plugin-sdk'

import type { FlowDir } from './layout'

/** The canvas page header: the page name and the layout flip. Same header as
 * the Kanban board — the page name here, the current workflow in the titlebar
 * (see WorkflowSwitcher). Theme and mode are the host's — they live in
 * Settings, not on this page. */
export function FlowHeader({ setDir, vertical }: { setDir: (to: FlowDir) => void; vertical: boolean }) {
  return (
    <PageHeader>
      <PageHeaderTitle>Workflows</PageHeaderTitle>
      <PageHeaderActions>
        {/* A divided box, not an arrow: the icon has to say "arrangement",
          and a lone chevron on a header button says "this opens something".
          It shows the layout you'd GET.
          
          The LABEL, though, names the control and doesn't change with it.
          You click this with the tip already open, so a label that swapped
          between two different-length strings resized and re-centred its
          bubble on every press — a flicker right under the header, for a
          state the icon is already showing. */}
        <Tip label="Flip layout direction">
          <Button
            aria-label="Flip layout direction"
            onClick={() => setDir(vertical ? 'LR' : 'TB')}
            size="icon-xs"
            variant="ghost"
          >
            <Codicon
              className="grid size-3.5 place-items-center"
              name={vertical ? 'split-vertical' : 'split-horizontal'}
              size="0.85rem"
            />
          </Button>
        </Tip>
      </PageHeaderActions>
    </PageHeader>
  )
}
