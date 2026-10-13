// Plugin-mountable chat surfaces: the REAL chat for a session the plugin
// owns, plus the composer chrome that keeps its input and control row
// reading as the app's own.
/** The composer control row's button vocabulary — a ghost icon for the
 *  secondary controls, a solid circle for the one primary action. Wear these on
 *  any control that rides the composer so a plugin's row reads as the same row. */
export {
  ACTIVE_ICON_BTN,
  GHOST_ICON_BTN,
  ICON_BTN,
  PRIMARY_ICON_BTN,
  PRIMARY_ICON_FACE
} from '@/app/chat/composer/control-classes'

/** A REAL Hermes chat, for a session the plugin owns — the same thread, tool
 *  cards, streaming indicators, attachments and composer the workspace pane
 *  renders, not a lookalike. The plugin creates or resumes the session and
 *  passes the ids; layout is the plugin's, styled from its own container the
 *  way HUD mode restyles the same tree. */
export {
  DetachedSessionChat as SessionChat,
  type DetachedSessionChatProps as SessionChatProps
} from '@/app/chat/detached-chat'

/** The composer's own chrome, so a plugin surface that carries an input can
 *  wear the real one instead of approximating it. `composerDockCard('top')` is
 *  the card that fuses above the composer (the status stack uses it). */
export {
  composerDockCard,
  composerFill,
  composerFloatingPill,
  composerFloatingStrip,
  composerPanelCard,
  composerSurfaceGlass
} from '@/components/chat/composer-dock'
