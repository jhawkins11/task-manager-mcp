<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import * as Dialog from '$lib/components/ui/dialog';
  
  export let open = false;
  export let questionId = '';
  export let question = '';
  export let options: string[] = [];
  export let allowsText = true;
  
  let userResponse = '';
  let selectedOption = '';
  const dispatch = createEventDispatcher();
  
  // Reset the form when the question changes
  $: if (questionId) {
    userResponse = '';
    selectedOption = '';
  }
  
  function handleSubmit() {
    // Use the selected option if options are provided and one is selected
    // Otherwise use the free text response
    const response = options.length > 0 && selectedOption 
      ? selectedOption 
      : userResponse;
      
    dispatch('response', {
      questionId,
      response
    });
    
    // Reset the form
    userResponse = '';
    selectedOption = '';
  }
  
  function handleCancel() {
    dispatch('cancel');
    
    // Reset the form
    userResponse = '';
    selectedOption = '';
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-w-md w-full">
    <Dialog.Header>
      <Dialog.Title>Clarification Needed</Dialog.Title>
    </Dialog.Header>
    
    <div class="py-4">
      <p class="text-foreground mb-5">{question}</p>
      
      <form on:submit|preventDefault={handleSubmit}>
        {#if options.length > 0}
          <div class="flex flex-col gap-3 mb-5">
            {#each options as option}
              <label class="flex items-center gap-2 p-3 border border-border rounded-md cursor-pointer hover:bg-muted transition-colors">
                <input 
                  type="radio" 
                  name="option" 
                  value={option}
                  bind:group={selectedOption}
                  class="focus:ring-primary"
                />
                <span class="text-foreground">{option}</span>
              </label>
            {/each}
          </div>
        {/if}
        
        {#if allowsText}
          <div class="mb-5">
            <label for="text-response" class="block mb-2 font-medium text-foreground">
              {options.length > 0 ? 'Or provide a custom response:' : 'Your response:'}
            </label>
            <textarea 
              id="text-response"
              rows="3"
              bind:value={userResponse}
              placeholder="Type your response here..."
              class="w-full p-3 border border-border rounded-md resize-y text-foreground bg-background focus:ring-primary focus:border-primary"
            ></textarea>
          </div>
        {/if}
        
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
            disabled={!allowsText && !selectedOption}
          >
            Submit Response
          </button>
        </Dialog.Footer>
      </form>
    </div>
  </Dialog.Content>
</Dialog.Root> 