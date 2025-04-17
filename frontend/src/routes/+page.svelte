<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';
	import { fade } from 'svelte/transition'; 
	import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Select from '$lib/components/ui/select';
	import { Progress } from '$lib/components/ui/progress';
	import { Loader2 } from 'lucide-svelte';
	import type { Task, WebSocketMessage } from '$lib/types'; // Import WebSocketMessage type
	import { TaskStatus, TaskEffort } from '$lib/types';
	import type { Selected } from 'bits-ui';

	let tasks: Task[] = [];
	let nestedTasks: Task[] = [];
	let loading = true;
	let error: string | null = null; 
	let featureId: string | null = null;
	let features: string[] = [];
	let loadingFeatures = true;
	// let loadingRefresh = false; // Can likely remove this
	// let pollingIntervalId: number | null = null; // Remove polling variable
	let ws: WebSocket | null = null;
	let wsStatus: 'connecting' | 'connected' | 'disconnected' = 'disconnected';

	// --- WebSocket Functions ---
	function connectWebSocket() {
		// Construct WebSocket URL (ws:// or wss:// based on protocol)
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		const wsUrl = `${protocol}//${window.location.host}`;
		
		console.log(`[WS Client] Attempting to connect to ${wsUrl}...`);
		wsStatus = 'connecting';
		ws = new WebSocket(wsUrl);

		ws.onopen = () => {
			console.log('[WS Client] WebSocket connection established.');
			wsStatus = 'connected';
			// Register this client for the current feature
			if (featureId && ws) {
				sendWsMessage({ 
					type: 'client_registration', 
					featureId: featureId,
					payload: { featureId: featureId, clientId: `browser-${Date.now()}` } // Basic client ID
				});
			}
		};

		ws.onmessage = (event) => {
			try {
				const message: WebSocketMessage = JSON.parse(event.data);
				console.log('[WS Client] Received message:', message);

				// Check if the message is for the currently viewed feature
				if (message.featureId && message.featureId !== featureId) {
					console.log('[WS Client] Ignoring message for different feature:', message.featureId);
					return;
				}

				switch (message.type) {
					case 'tasks_updated':
					case 'status_changed': // Refresh on status change too
						console.log(`[WS Client] Received ${message.type}, refreshing tasks for feature ${featureId}...`);
						refreshTasks(); // Re-fetch tasks for the current feature
						break;
					case 'error':
						console.error('[WS Client] Received error message:', message.payload);
						// Optionally display a user-facing error
						break;
					case 'connection_established':
						console.log('[WS Client] Server confirmed connection.');
						break;
					case 'client_registration':
						console.log('[WS Client] Server confirmed registration:', message.payload);
						break;
					// Add other message type handlers if needed
				}
			} catch (e) {
				console.error('[WS Client] Error processing message:', e);
			}
		};

		ws.onerror = (error) => {
			console.error('[WS Client] WebSocket error:', error);
			wsStatus = 'disconnected';
			// Optionally add more robust error handling or reconnection attempts
		};

		ws.onclose = (event) => {
			console.log(`[WS Client] WebSocket connection closed. Code: ${event.code}, Reason: ${event.reason}`);
			wsStatus = 'disconnected';
			ws = null;
			// Attempt to reconnect after a delay?
			// setTimeout(connectWebSocket, 5000); // Example: Try reconnecting after 5 seconds
		};
	}

	function sendWsMessage(message: WebSocketMessage) {
		if (ws && ws.readyState === WebSocket.OPEN) {
			try {
				ws.send(JSON.stringify(message));
				console.log('[WS Client] Sent message:', message);
			} catch (e) {
				console.error('[WS Client] Error sending message:', e);
			}
		} else {
			console.warn('[WS Client] Cannot send message, WebSocket not open.');
		}
	}

	// --- Component Lifecycle & Data Fetching ---

	async function fetchTasks(selectedFeatureId?: string) {
		loading = true;
		error = '';
		
		try {
			// Construct the API endpoint based on whether we have a featureId
			const endpoint = selectedFeatureId 
				? `/api/tasks/${selectedFeatureId}` 
				: '/api/tasks';
			
			const response = await fetch(endpoint);
			if (!response.ok) {
				throw new Error(`Failed to fetch tasks: ${response.statusText}`);
			}
			
			const data = await response.json();
			
			// Convert API response to our Task type
			tasks = data.map((task: any) => {
				// Ensure status is one of our enum values
				let status: TaskStatus;
				if (task.status === 'completed') {
					status = TaskStatus.COMPLETED;
				} else if (task.status === 'in_progress') {
					status = TaskStatus.IN_PROGRESS;
				} else {
					status = TaskStatus.PENDING;
				}
				
				// Ensure effort is one of our enum values
				let effort: TaskEffort = TaskEffort.MEDIUM; // Default
				if (task.effort === 'low') {
					effort = TaskEffort.LOW;
				} else if (task.effort === 'high') {
					effort = TaskEffort.HIGH;
				}
				
				// Derive title from description if not present
				const title = task.title || task.description;
				
				// Ensure completed flag is consistent with status
				const completed = status === TaskStatus.COMPLETED;
				
				// Return the fully mapped task
				return {
					id: task.id,
					title,
					description: task.description,
					status,
					completed,
					effort,
					feature_id: task.feature_id || selectedFeatureId || undefined,
					parentTaskId: task.parentTaskId,
					createdAt: task.createdAt,
					updatedAt: task.updatedAt
				} as Task;
			});
			
			if (tasks.length === 0) {
				error = 'No tasks found for this feature.';
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'An error occurred';
			console.error('Error fetching tasks:', err);
			tasks = []; // Clear any previous tasks
		} finally {
			loading = false;
		}
	}

	async function fetchFeatures() {
		loadingFeatures = true;
		try {
			const response = await fetch('/api/features');
			if (!response.ok) {
				throw new Error('Failed to fetch features');
			}
			features = await response.json();
		} catch (err) {
			console.error('Error fetching features:', err);
			features = [];
		} finally {
			loadingFeatures = false;
		}
	}

	onMount(async () => {
		// Extract featureId from URL query parameters
		featureId = $page.url.searchParams.get('featureId');
		
		// Fetch features first
		await fetchFeatures();
		
		// Initial task fetch logic (remains the same)
		if (!featureId && features.length > 0) {
			await fetchTasks(); 
			if (tasks.length > 0 && tasks[0].feature_id) {
				featureId = tasks[0].feature_id;
			}
		} else if (featureId) {
			await fetchTasks(featureId);
		} else {
			loading = false; 
			if (!error) { 
				error = 'No features found. Create a feature first using the task manager CLI.';
			}
		}

		// Connect WebSocket AFTER initial data load and featureId determination
		connectWebSocket();

		// Remove polling logic
		/*
		pollingIntervalId = window.setInterval(() => {
			if (!loading) {
				console.log('Polling for task updates...');
				refreshTasks();
			}
		}, 10000);
		*/
	});

	onDestroy(() => {
		// Clean up WebSocket connection
		if (ws) {
			console.log('[WS Client] Closing WebSocket connection.');
			ws.close();
			ws = null;
		}

		// Remove polling cleanup
		/*
		if (pollingIntervalId) {
			clearInterval(pollingIntervalId);
			console.log('Cleared task polling interval.'); 
		}
		*/
	});

	function toggleTaskStatus(taskId: string) {
		// The UI update happens optimistically as before
		const taskIndex = tasks.findIndex((t) => t.id === taskId);
		if (taskIndex !== -1) {
			const task = tasks[taskIndex];
			const newStatus = task.status === TaskStatus.COMPLETED ? TaskStatus.PENDING : TaskStatus.COMPLETED;
			tasks[taskIndex].status = newStatus;
			tasks[taskIndex].completed = newStatus === TaskStatus.COMPLETED;
			tasks = [...tasks];
			processNestedTasks();
		}
		// NOTE: We no longer need to manually trigger a backend update here 
		// if the external 'mark_complete' tool is the source of truth for completion.
		// If toggling the checkbox *should* also update the backend, 
		// we'd need a separate fetch call here, and the backend should broadcast.
	}

	function getEffortBadgeVariant(effort: string) {
		switch (effort) {
			case TaskEffort.LOW:
				return 'secondary';
			case TaskEffort.MEDIUM:
				return 'default';
			case TaskEffort.HIGH:
				return 'destructive';
			default:
				return 'outline';
		}
	}

	function getStatusBadgeVariant(status: string) {
		switch (status) {
			case TaskStatus.COMPLETED:
				return 'secondary';
			case TaskStatus.IN_PROGRESS:
				return 'default';
			case TaskStatus.PENDING:
				return 'outline';
			default:
				return 'outline';
		}
	}

	function processNestedTasks() {
		// Define the type for map values explicitly
		type TaskWithChildren = Task & { children: Task[] };

		const taskMap = new Map<string, TaskWithChildren>(
			tasks.map(task => [task.id, { ...task, children: [] }])
		);
		const rootTasks: Task[] = [];

		taskMap.forEach((task: TaskWithChildren) => { 
			if (task.parentTaskId && taskMap.has(task.parentTaskId)) {
				const parent = taskMap.get(task.parentTaskId);
				if (parent) {
					parent.children.push(task);
				} else {
					rootTasks.push(task);
				}
			} else {
				rootTasks.push(task);
			}
		});

		// Optional: Sort root tasks or children if needed
		// rootTasks.sort(...); 
		// taskMap.forEach(task => task.children.sort(...));

		nestedTasks = rootTasks;
	}

	function refreshTasks() {
		if (loading) return;
		console.log('[Task List] Refreshing tasks...') 
		fetchTasks(featureId || undefined);
	}

	function handleFeatureChange(selectedItem: Selected<string> | undefined) {
		const newFeatureId = selectedItem?.value; // Safely get value
		
		if (newFeatureId && newFeatureId !== featureId) { 
			featureId = newFeatureId;
			
			// Update URL 
			const url = new URL(window.location.href);
			url.searchParams.set('featureId', newFeatureId);
			window.history.pushState({}, '', url);
			
			// Fetch tasks for the new feature
			fetchTasks(newFeatureId);

			// Re-register WebSocket for the new feature
			if (ws && wsStatus === 'connected') {
				sendWsMessage({ 
					type: 'client_registration', 
					featureId: featureId,
					payload: { featureId: featureId, clientId: `browser-${Date.now()}` }
				});
			}
		}
	}

	// ... reactive variables ...
	$: completedCount = tasks.filter(t => t.completed).length;
	$: totalTasks = tasks.length;
	$: progress = totalTasks > 0 ? (completedCount / totalTasks) * 100 : 0;
	$: firstPendingTaskIndex = tasks.findIndex(t => t.status === TaskStatus.PENDING);
	$: selectedFeatureLabel = features.find(f => f === featureId) || 'Select Feature';

	// Call processNestedTasks whenever the raw tasks array changes
	$: if (tasks) {
		processNestedTasks();
	}

</script>

<div class="container mx-auto py-10 px-4 sm:px-6 lg:px-8 max-w-5xl">
	<div class="flex justify-between items-center mb-8">
		<h1 class="text-3xl font-bold tracking-tight text-foreground">Task Manager</h1>
		{#if features.length > 0}
			<div class="w-64">
				<Select.Root 
					onSelectedChange={handleFeatureChange} 
					selected={featureId ? { value: featureId, label: featureId } : undefined}
					disabled={loadingFeatures}
				>
					<Select.Trigger class="w-full">
						{featureId ? featureId.substring(0, 8) + '...' : 'Select Feature'}
					</Select.Trigger>
					<Select.Content>
						<Select.Group>
							<Select.GroupHeading>Available Features</Select.GroupHeading>
							{#each features as feature}
								<Select.Item value={feature} label={feature}>{feature.substring(0, 8)}...</Select.Item>
							{/each}
						</Select.Group>
					</Select.Content>
				</Select.Root>
			</div>
		{/if}
	</div>

	{#if loading}
		<div class="flex justify-center items-center h-64">
			<Loader2 class="h-12 w-12 animate-spin text-primary" />
		</div>
	{:else if error}
		<Card class="mb-6 border-destructive">
			<CardHeader>
				<CardTitle class="text-destructive">Error Loading Tasks</CardTitle>
				<CardDescription class="text-destructive/90">{error}</CardDescription>
			</CardHeader>
		</Card>
	{:else}
		<Card class="shadow-lg">
			<CardHeader class="border-b border-border px-6 py-4">
				<CardTitle class="text-xl font-semibold flex justify-between items-center">
					<span>Tasks</span>
					<Badge variant="secondary">{tasks.length}</Badge>
				</CardTitle>
				<CardDescription class="mt-1">
					Manage your tasks and track progress for the selected feature.
				</CardDescription>
				<div class="pt-4">
					<Progress 
						value={progress} 
						class="w-full h-2 [&>div]:bg-green-500 [&>div]:transition-all [&>div]:duration-300 [&>div]:ease-in-out"
					/>
				</div>
			</CardHeader>
			<CardContent class="p-0">
				<div class="divide-y divide-border">
					{#each nestedTasks as task (task.id)}
						{@const taskIndexInFlatList = tasks.findIndex(t => t.id === task.id)}
						{@const isNextPending = taskIndexInFlatList === firstPendingTaskIndex}
						{@const isInProgress = task.status === TaskStatus.IN_PROGRESS}
						<div 
							transition:fade={{ duration: 200 }}
							class="task-row flex items-start space-x-4 p-4 hover:bg-muted/50 transition-colors 
								   {isNextPending ? 'bg-muted/30' : ''} 
								   {isInProgress ? 'in-progress-shine relative overflow-hidden' : ''}
								   {task.completed ? 'opacity-60' : ''}"
						>
							{#if isNextPending}
								<div class="flex items-center justify-center h-6 w-6 mt-1">
									<Loader2 class="h-4 w-4 animate-spin text-primary" />
								</div>
							{:else}
								<Checkbox 
									id={`task-${task.id}`} 
									checked={task.completed} 
									onCheckedChange={() => toggleTaskStatus(task.id)} 
									aria-labelledby={`task-label-${task.id}`}
									class="mt-1"
									disabled={task.status === TaskStatus.IN_PROGRESS}
								/>
							{/if}
							<div class="flex-1 grid gap-1">
								<div class="flex items-center gap-2">
									<label 
										for={`task-${task.id}`} 
										id={`task-label-${task.id}`}
										class={`font-medium cursor-pointer ${task.completed ? 'line-through text-muted-foreground' : ''}`}
									>
										{task.title}
									</label>
								</div>
								{#if task.description && task.description !== task.title}
									<p class="text-sm text-muted-foreground">
										{task.description}
									</p>
								{/if}
							</div>
							<div class="flex flex-col gap-1.5 items-end min-w-[100px]">
								<Badge variant={getStatusBadgeVariant(task.status)} class="capitalize">
									{task.status.replace('_', ' ')}
								</Badge>
								{#if task.effort}
									<Badge variant={getEffortBadgeVariant(task.effort)} class="capitalize">
										{task.effort}
									</Badge>
								{/if}
							</div>
						</div>
						{#if task.children && task.children.length > 0}
							<div class="ml-8 pl-4 border-l border-border">
								{#each task.children as childTask (childTask.id)}
									{@const childTaskIndexInFlatList = tasks.findIndex(t => t.id === childTask.id)}
									{@const isChildNextPending = childTaskIndexInFlatList === firstPendingTaskIndex}
									{@const isChildInProgress = childTask.status === TaskStatus.IN_PROGRESS}
									<div 
										transition:fade={{ duration: 200 }}
										class="task-row flex items-start space-x-4 py-3 
											   {isChildNextPending ? 'bg-muted/30' : ''} 
											   {isChildInProgress ? 'in-progress-shine relative overflow-hidden' : ''}
											   {childTask.completed ? 'opacity-60' : ''}"
									>
										{#if isChildNextPending}
											<div class="flex items-center justify-center h-6 w-6 mt-1">
												<Loader2 class="h-4 w-4 animate-spin text-primary" />
											</div>
										{:else}
											<Checkbox 
												id={`task-${childTask.id}`} 
												checked={childTask.completed} 
												onCheckedChange={() => toggleTaskStatus(childTask.id)} 
												aria-labelledby={`task-label-${childTask.id}`}
												class="mt-1"
												disabled={childTask.status === TaskStatus.IN_PROGRESS}
											/>
										{/if}
										<div class="flex-1 grid gap-1">
											<div class="flex items-center gap-2">
												<label 
													for={`task-${childTask.id}`} 
													id={`task-label-${childTask.id}`}
													class={`font-medium cursor-pointer ${childTask.completed ? 'line-through text-muted-foreground' : ''}`}
												>
													{childTask.title}
												</label>
											</div>
											{#if childTask.description && childTask.description !== childTask.title}
												<p class="text-sm text-muted-foreground">
													{childTask.description}
												</p>
											{/if}
										</div>
										<div class="flex flex-col gap-1.5 items-end min-w-[100px]">
											<Badge variant={getStatusBadgeVariant(childTask.status)} class="capitalize">
												{childTask.status.replace('_', ' ')}
											</Badge>
											{#if childTask.effort}
												<Badge variant={getEffortBadgeVariant(childTask.effort)} class="capitalize">
													{childTask.effort}
												</Badge>
											{/if}
										</div>
									</div>
								{/each}
							</div>
						{/if}
					{:else}
						<div class="text-center py-8 text-muted-foreground">
							No tasks found for this feature.
						</div>
					{/each}
				</div>
			</CardContent>
			<CardFooter class="flex flex-col items-start gap-4 px-6 py-4 border-t border-border">
				<div class="w-full flex justify-between items-center">
					<span class="text-sm text-muted-foreground">
						{completedCount} of {totalTasks} tasks completed
					</span>
					<Button variant="outline" size="sm" on:click={refreshTasks} disabled={loading}>
						{#if loading}
							<Loader2 class="mr-2 h-4 w-4 animate-spin" />
						{/if}
						Refresh
					</Button>
				</div>
			</CardFooter>
		</Card>
	{/if}
</div>

<style>
	.in-progress-shine::before {
		content: '';
		position: absolute;
		top: 0;
		left: -100%; /* Start off-screen */
		width: 75%; /* Width of the shine */
		height: 100%;
		background: linear-gradient(
			100deg,
			rgba(255, 255, 255, 0) 0%,
			rgba(255, 255, 255, 0.15) 50%, /* Subtle white shine */
			rgba(255, 255, 255, 0) 100%
		);
		transform: skewX(-25deg); /* Angle the shine */
		animation: shine 2.5s infinite linear; /* Animation properties */
		opacity: 0.8;
	}

	@keyframes shine {
		0% {
			left: -100%;
		}
		50%, 100% { /* Speed up the animation and make it pause less */
			left: 120%; /* Move across and off-screen */
		}
	}

	.task-row {
		position: relative; /* Needed for absolute positioning of ::before */
		overflow: hidden; /* Keep shine contained */
	}
</style>

