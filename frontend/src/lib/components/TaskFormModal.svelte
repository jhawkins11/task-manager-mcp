<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import * as Dialog from '$lib/components/ui/dialog';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  
  export let open = false;
  export let featureId = '';
  export let isEditing = false;
  export let editTask = {
    id: '',
    title: '',
    effort: 'medium' as 'low' | 'medium' | 'high'
  };
  
  let title = '';
  let effort: 'low' | 'medium' | 'high' = 'medium';
  
  const dispatch = createEventDispatcher();
  
  $: canSubmit = title.trim() !== '';
  
  function handleSubmit() {
    if (!canSubmit) return;
    
    dispatch('submit', {
      title,
      effort,
      featureId
    });
    
    // Reset the form
    resetForm();
  }
  
  function handleCancel() {
    dispatch('cancel');
    resetForm();
  }
  
  function resetForm() {
    title = '';
    effort = 'medium';
  }
  
  // Reset the form or populate with editing values when the modal opens
  $: if (open) {
    if (isEditing && editTask) {
      title = editTask.title;
      effort = editTask.effort;
    } else {
      resetForm();
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-w-md w-full">
    <Dialog.Header>
      <Dialog.Title>{isEditing ? 'Edit Task' : 'Add New Task'}</Dialog.Title>
      <Dialog.Description>
        {isEditing ? 'Update task title and effort.' : 'Create a new task for this feature.'}
      </Dialog.Description>
    </Dialog.Header>
    
    <div class="py-4">
      <form on:submit|preventDefault={handleSubmit}>
        <div class="grid gap-4 mb-5">
          <div class="grid gap-2">
            <Label for="title">Title*</Label>
            <Input id="title" bind:value={title} placeholder="Task title" required />
          </div>
          
          <div class="grid gap-2">
            <Label for="effort">Effort Level</Label>
            <select 
              id="effort" 
              bind:value={effort} 
              class="w-full p-2 border border-border rounded-md bg-background text-foreground"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
        </div>
        
        <Dialog.Footer class="flex justify-end gap-3 pt-2">
          <Dialog.Close>
            <button 
              type="button" 
              class="bg-secondary text-secondary-foreground hover:bg-secondary/90 px-4 py-2 rounded-md font-medium text-sm"
              on:click={handleCancel}
            >
              Cancel
            </button>
          </Dialog.Close>
          <button 
            type="submit" 
            class="bg-primary text-primary-foreground hover:bg-primary/90 px-4 py-2 rounded-md font-medium text-sm disabled:opacity-50"
            disabled={!canSubmit}
          >
            {isEditing ? 'Update Task' : 'Add Task'}
          </button>
        </Dialog.Footer>
      </form>
    </div>
  </Dialog.Content>
</Dialog.Root> 