import { createApp } from 'vue'
import App from '../App.vue'
import CollaborationModule from './CollaborationModule.vue'
import type { ApprovalHostService } from '../../../dopame-system/services/marktextdocs-approval-host'
import '../style.css'

/** The collaboration edition: the same editor, with the author's collaboration module beside it. */
export function mountCollaborativeEditor(service: ApprovalHostService) {
  createApp(App, { collaboration: service, collaborationModule: CollaborationModule }).mount('#app')
}
