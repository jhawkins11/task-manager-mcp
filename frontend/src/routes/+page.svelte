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
	import { Loader2, CornerDownLeft, CornerDownRight, Pencil, Trash2 } from 'lucide-svelte';
	import { writable, type Writable } from 'svelte/store';
	import type { Task, WebSocketMessage, ShowQuestionPayload, QuestionResponsePayload } from '$lib/types';
	import { TaskStatus, TaskEffort } from '$lib/types';
	import type { Selected } from 'bits-ui';
	import QuestionModal from '$lib/components/QuestionModal.svelte';
	import TaskFormModal from '$lib/components/TaskFormModal.svelte';

	// Convert to writable stores for better state management
	const tasks: Writable<Task[]> = writable([]);
	let nestedTasks: Task[] = [];
	const loading: Writable<boolean> = writable(true);
	const error: Writable<string | null> = writable(null);
	let featureId: string | null = null;
	let features: string[] = [];
	let loadingFeatures = true;
	let ws: WebSocket | null = null;
	let wsStatus: 'connecting' | 'connected' | 'disconnected' = 'disconnected';

	// Question modal state
	let showQuestionModal = false;
	let questionData: ShowQuestionPayload | null = null;

	// Task form modal state
	let showTaskFormModal = false;
	let editingTask: Task | null = null;
	let isEditing = false;

	// Reactive statement to update nestedTasks when tasks store changes
	$: {
		const taskMap = new Map<string, Task & { children: Task[] }>();
		const rootTasks: Task[] = [];

		// Use the tasks from the store ($tasks)
		$tasks.forEach(task => {
			// Ensure the task object has the correct type including children array
			const taskWithChildren: Task & { children: Task[] } = {
				...task,
				children: []
			};
			taskMap.set(task.id, taskWithChildren);
		});

		$tasks.forEach(task => {
			const currentTask = taskMap.get(task.id)!; // Should always exist
			if (task.parentTaskId && taskMap.has(task.parentTaskId)) {
				taskMap.get(task.parentTaskId)!.children.push(currentTask);
			} else {
				rootTasks.push(currentTask);
			}
		});

		nestedTasks = rootTasks;
	}

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
						console.log(`[WS Client] Received tasks_updated for feature ${featureId}:`, message.payload.tasks);
						if (message.payload?.tasks) {
							// Directly update tasks store instead of triggering a fetch
							tasks.set(message.payload.tasks as Task[]);
							// Explicitly set loading to false
							loading.set(false);
							error.set(null); // Clear any previous errors
						}
						break;
					case 'status_changed':
						console.log(`[WS Client] Received status_changed for task ${message.payload?.taskId}`);
						if (message.payload?.taskId && message.payload?.status) {
							// Map incoming status string to TaskStatus enum
							let newStatus: TaskStatus;
							switch (message.payload.status) {
								case 'completed': newStatus = TaskStatus.COMPLETED; break;
								case 'in_progress': newStatus = TaskStatus.IN_PROGRESS; break;
								case 'decomposed': newStatus = TaskStatus.DECOMPOSED; break;
								default: newStatus = TaskStatus.PENDING; break;
							}
							
							tasks.update(currentTasks =>
								currentTasks.map(task =>
									task.id === message.payload.taskId
										? { 
											...task, 
											status: newStatus, 
											// Completed is true ONLY if status is COMPLETED
											completed: newStatus === TaskStatus.COMPLETED 
										  }
										: task
								)
							);
							// Status change doesn't imply general loading state change
						}
						break;
					case 'show_question':
						console.log('[WS Client] Received clarification question:', message.payload);
						// Store question data and show modal
						questionData = message.payload as ShowQuestionPayload;
						showQuestionModal = true;
						// When question arrives, we should stop loading indicator
						loading.set(false);
						break;
					case 'error':
						console.error('[WS Client] Received error message:', message.payload);
						// Display user-facing error
						error.set(message.payload?.message || 'Received error from server.');
						// Error likely means loading is done (with an error)
						loading.set(false);
						break;
					case 'task_created':
						console.log('[WS Client] Received task_created:', message.payload);
						if (message.payload?.task) {
							// Map incoming task to our Task type
							const newTask = mapApiTaskToClientTask(message.payload.task, message.featureId || featureId || '');
							// Add the new task to the store
							tasks.update(currentTasks => [...currentTasks, newTask]);
							// Process nested structure
							processNestedTasks();
						}
						break;
					case 'task_updated':
						console.log('[WS Client] Received task_updated:', message.payload);
						if (message.payload?.task) {
							// Map incoming task to our Task type
							const updatedTask = mapApiTaskToClientTask(message.payload.task, message.featureId || featureId || '');
							// Update the existing task in the store
							tasks.update(currentTasks =>
								currentTasks.map(task =>
									task.id === updatedTask.id ? updatedTask : task
								)
							);
							// Process nested structure
							processNestedTasks();
						}
						break;
					case 'task_deleted':
						console.log('[WS Client] Received task_deleted:', message.payload);
						if (message.payload?.taskId) {
							// Remove the task from the store
							tasks.update(currentTasks =>
								currentTasks.filter(task => task.id !== message.payload.taskId)
							);
							// Process nested structure
							processNestedTasks();
						}
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
				loading.set(false); // Ensure loading is set to false on error
			}
		};

		ws.onerror = (error) => {
			console.error('[WS Client] WebSocket error:', error);
			wsStatus = 'disconnected';
			loading.set(false); // Ensure loading is false on WebSocket error
		};

		ws.onclose = (event) => {
			console.log(`[WS Client] WebSocket connection closed. Code: ${event.code}, Reason: ${event.reason}`);
			wsStatus = 'disconnected';
			ws = null;
			// Ensure loading is false when WebSocket disconnects
			loading.set(false);
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
		loading.set(true);
		error.set(null);
		
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
			const mappedData = data.map((task: any) => {
				// Map incoming status string to TaskStatus enum
				let status: TaskStatus;
				switch (task.status) {
					case 'completed': status = TaskStatus.COMPLETED; break;
					case 'in_progress': status = TaskStatus.IN_PROGRESS; break;
					case 'decomposed': status = TaskStatus.DECOMPOSED; break;
					default: status = TaskStatus.PENDING; break;
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
			
			tasks.set(mappedData);
			
			if (mappedData.length === 0) {
				error.set('No tasks found for this feature.');
			}
		} catch (err) {
			error.set(err instanceof Error ? err.message : 'An error occurred');
			// Add more detailed logging
			console.error('[fetchTasks] Error fetching tasks:', err);
			if (err instanceof Error && err.cause) {
				console.error('[fetchTasks] Error Cause:', err.cause);
			}
			tasks.set([]); // Clear any previous tasks
		} finally {
			// Always reset loading state when fetch completes
			loading.set(false);
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

	// New function to fetch pending question
	async function fetchPendingQuestion(id: string): Promise<ShowQuestionPayload | null> {
		console.log(`[Pending Question] Checking for feature ${id}...`);
		try {
			const response = await fetch(`/api/features/${id}/pending-question`);
			if (!response.ok) {
				throw new Error(`HTTP error! status: ${response.status}`);
			}
			const data: ShowQuestionPayload | null = await response.json();
			if (data) {
				console.log('[Pending Question] Found pending question:', data);
				return data;
			} else {
				console.log('[Pending Question] No pending question found.');
				return null;
			}
		} catch (err) {
			console.error('[Pending Question] Error fetching pending question:', err);
			error.set(err instanceof Error ? `Error checking for pending question: ${err.message}` : 'An error occurred while checking for pending questions.');
			return null;
		}
	}

	function processNestedTasks() {
		// Define the type for map values explicitly
		type TaskWithChildren = Task & { children: Task[] };

		const taskMap = new Map<string, TaskWithChildren>(
			$tasks.map(task => [task.id, { ...task, children: [] }])
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

	async function addTask(taskData: { title: string; effort: string; featureId: string }) {
		try {
			const response = await fetch('/api/tasks', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					...taskData,
					description: taskData.title // Use title as description
				})
			});

			if (!response.ok) {
				throw new Error(`Failed to create task: ${response.statusText}`);
			}

			const newTask = await response.json();
			console.log('[Task] New task created:', newTask);

			// Refresh the tasks list
			await fetchTasks(taskData.featureId);
			
			// Clear any errors that might have been shown
			error.set(null);
		} catch (err) {
			console.error('[Task] Error creating task:', err);
			error.set(err instanceof Error ? err.message : 'Failed to create task');
		}
	}

	function handleTaskFormSubmit(event: CustomEvent) {
		const taskData = event.detail;
		if (isEditing && editingTask) {
			updateTask(editingTask.id, taskData);
		} else {
			addTask(taskData);
		}
		showTaskFormModal = false;
		isEditing = false;
		editingTask = null;
	}

	function openEditTaskModal(task: Task) {
		editingTask = task;
		isEditing = true;
		showTaskFormModal = true;
	}

	async function updateTask(taskId: string, taskData: { title: string; effort: string; featureId: string }) {
		try {
			const response = await fetch(`/api/tasks/${taskId}`, {
				method: 'PUT',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					...taskData,
					description: taskData.title, // Use title as description
					featureId: taskData.featureId
				})
			});

			if (!response.ok) {
				throw new Error(`Failed to update task: ${response.statusText}`);
			}

			const updatedTask = await response.json();
			console.log('[Task] Task updated:', updatedTask);

			// Refresh the tasks list
			await fetchTasks(taskData.featureId);
			
			// Clear any errors that might have been shown
			error.set(null);
		} catch (err) {
			console.error('[Task] Error updating task:', err);
			error.set(err instanceof Error ? err.message : 'Failed to update task');
		}
	}

	async function deleteTask(taskId: string, featureId: string) {
		if (!confirm('Are you sure you want to delete this task?')) {
			return;
		}
		
		try {
			const response = await fetch(`/api/tasks/${taskId}?featureId=${featureId}`, {
				method: 'DELETE'
			});

			if (!response.ok) {
				throw new Error(`Failed to delete task: ${response.statusText}`);
			}

			console.log('[Task] Task deleted:', taskId);

			// Refresh the tasks list
			await fetchTasks(featureId);
			
			// Clear any errors that might have been shown
			error.set(null);
		} catch (err) {
			console.error('[Task] Error deleting task:', err);
			error.set(err instanceof Error ? err.message : 'Failed to delete task');
		}
	}

	onMount(async () => {
		loading.set(true); // Set loading true at the start
		error.set(null); // Reset error

		// Extract featureId from URL query parameters
		featureId = $page.url.searchParams.get('featureId');
		
		// Fetch available features first
		await fetchFeatures();
		
		// Determine the featureId to use (from URL or latest)
		if (!featureId && features.length > 0) {
			// Attempt to fetch default tasks to find the latest featureId
			await fetchTasks(); 
			if ($tasks.length > 0 && $tasks[0]?.feature_id) {
				featureId = $tasks[0].feature_id;
				console.log(`[onMount] Determined latest featureId: ${featureId}`);
			} else {
				console.log('[onMount] Could not determine latest featureId from default tasks.');
				// If no featureId determined, use the first from the list if available
				if (features.length > 0) {
					featureId = features[0];
					console.log(`[onMount] Using first available featureId: ${featureId}`);
				}
			}
		}
		
		// Now, if we have a featureId, check for pending questions and fetch tasks
		if (featureId) {
			console.log(`[onMount] Operating with featureId: ${featureId}`);
			// Check for pending question first
			const pendingQuestion = await fetchPendingQuestion(featureId);
			if (pendingQuestion) {
				questionData = pendingQuestion;
				showQuestionModal = true;
				// Still fetch tasks even if question is shown, they might exist
				await fetchTasks(featureId);
			} else {
				// No pending question, just fetch tasks
				await fetchTasks(featureId);
			}
		} else {
			// No featureId could be determined
			console.log('[onMount] No featureId available.');
			if (!$error) { // Only set error if fetchTasks didn't already set one
				error.set('No features found. Create a feature first using the task manager CLI.');
			}
			tasks.set([]); // Ensure tasks are empty
			nestedTasks = [];
		}

		// Connect WebSocket AFTER initial data load and featureId determination
		if (featureId) {
			connectWebSocket();
		}
	});

	onDestroy(() => {
		// Clean up WebSocket connection
		if (ws) {
			console.log('[WS Client] Closing WebSocket connection.');
			ws.close();
			ws = null;
		}
	});

	function toggleTaskStatus(taskId: string) {
		const tasksList = $tasks;
		const taskIndex = tasksList.findIndex((t) => t.id === taskId);
		if (taskIndex !== -1) {
			const task = tasksList[taskIndex];
			const newStatus = task.status === TaskStatus.COMPLETED ? TaskStatus.PENDING : TaskStatus.COMPLETED;
			tasks.update(currentTasks =>
				currentTasks.map(t =>
					t.id === taskId
						? { ...t, status: newStatus, completed: newStatus === TaskStatus.COMPLETED }
						: t
				)
			);
			processNestedTasks();
		}
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

	function getStatusBadgeVariant(status: TaskStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
		switch (status) {
			case TaskStatus.COMPLETED:
				return 'secondary';
			case TaskStatus.IN_PROGRESS:
				return 'default';
			case TaskStatus.DECOMPOSED:
				return 'outline';
			case TaskStatus.PENDING:
			default:
				return 'outline';
		}
	}

	function refreshTasks() {
		if ($loading) return;
		console.log('[Task List] Refreshing tasks...');
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

	// Handle user response to clarification question
	function handleQuestionResponse(event: CustomEvent) {
		const response = event.detail;
		console.log('[WS Client] User responded to question:', response);
		
		if (questionData && featureId) {
			// Send the response back to the server
			sendWsMessage({
				type: 'question_response', 
				featureId,
				payload: {
					questionId: questionData.questionId,
					response: response.response
				} as QuestionResponsePayload
			});
			
			// Reset modal state
			showQuestionModal = false;
			questionData = null;
		}
	}

	// Handle user cancellation of question
	function handleQuestionCancel() {
		console.log('[WS Client] User cancelled question');
		showQuestionModal = false;
		questionData = null;
	}

	// ... reactive variables ...
	// Filter out decomposed tasks from progress calculation
	$: actionableTasks = $tasks.filter(t => t.status !== TaskStatus.DECOMPOSED);
	$: completedCount = actionableTasks.filter(t => t.completed).length;
	$: totalActionableTasks = actionableTasks.length;
	$: progress = totalActionableTasks > 0 ? (completedCount / totalActionableTasks) * 100 : 0;
	$: firstPendingTaskIndex = $tasks.findIndex(t => t.status === TaskStatus.PENDING);
	$: selectedFeatureLabel = features.find(f => f === featureId) || 'Select Feature';

	// Call processNestedTasks whenever the raw tasks array changes
	$: {
		if ($tasks) {
			processNestedTasks();
		}
	}

	// Helper function to map API task response to client Task type
	function mapApiTaskToClientTask(apiTask: any, currentFeatureId: string): Task {
		// Map incoming status string to TaskStatus enum
		let status: TaskStatus;
		switch (apiTask.status) {
			case 'completed': status = TaskStatus.COMPLETED; break;
			case 'in_progress': status = TaskStatus.IN_PROGRESS; break;
			case 'decomposed': status = TaskStatus.DECOMPOSED; break;
			default: status = TaskStatus.PENDING; break;
		}
		
		// Ensure effort is one of our enum values
		let effort: TaskEffort = TaskEffort.MEDIUM; // Default
		if (apiTask.effort === 'low') {
			effort = TaskEffort.LOW;
		} else if (apiTask.effort === 'high') {
			effort = TaskEffort.HIGH;
		}
		
		// Derive title from description if not present
		const title = apiTask.title || apiTask.description;
		
		// Ensure completed flag is consistent with status
		const completed = status === TaskStatus.COMPLETED;
		
		// Return the fully mapped task
		return {
			id: apiTask.id,
			title,
			description: apiTask.description,
			status,
			completed,
			effort,
			feature_id: apiTask.feature_id || currentFeatureId,
			parentTaskId: apiTask.parentTaskId,
			createdAt: apiTask.createdAt,
			updatedAt: apiTask.updatedAt
		} as Task;
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

	{#if $loading}
		<div class="flex justify-center items-center h-64">
			<Loader2 class="h-12 w-12 animate-spin text-primary" />
		</div>
	{:else if $error}
		<Card class="mb-6 border-destructive">
			<CardHeader>
				<CardTitle class="text-destructive">Error Loading Tasks</CardTitle>
				<CardDescription class="text-destructive/90">{$error}</CardDescription>
			</CardHeader>
		</Card>
	{:else}
		<Card class="shadow-lg">
			<CardHeader class="border-b border-border px-6 py-4">
				<CardTitle class="text-xl font-semibold flex justify-between items-center">
					<span>Tasks</span>
					<Badge variant="secondary">{$tasks.length}</Badge>
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
						{@const taskIndexInFlatList = $tasks.findIndex(t => t.id === task.id)}
						{@const isNextPending = taskIndexInFlatList === firstPendingTaskIndex}
						{@const isInProgress = task.status === TaskStatus.IN_PROGRESS}
						{@const areAllChildrenComplete = task.children && task.children.length > 0 && task.children.every(c => c.status === TaskStatus.COMPLETED)}
						<div 
							transition:fade={{ duration: 200 }}
							class="task-row flex items-start space-x-4 p-4 hover:bg-muted/50 transition-colors 
								   {isNextPending ? 'bg-muted/30' : ''} 
								   {isInProgress ? 'in-progress-shine relative overflow-hidden' : ''}
								   {(task.status === TaskStatus.COMPLETED || (task.status === TaskStatus.DECOMPOSED && areAllChildrenComplete)) ? 'opacity-60' : ''}"
						>
							{#if isNextPending}
								<div class="flex items-center justify-center h-6 w-6 mt-1">
									<Loader2 class="h-4 w-4 animate-spin text-primary" />
								</div>
							{:else if task.status === TaskStatus.DECOMPOSED}
								<div class="flex items-center justify-center h-6 w-6 mt-1 text-muted-foreground">
									<CornerDownRight class="h-4 w-4" />
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
										class={`font-medium cursor-pointer ${(task.status === TaskStatus.COMPLETED || (task.status === TaskStatus.DECOMPOSED && areAllChildrenComplete)) ? 'line-through text-muted-foreground' : ''}`}
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
							<div class="flex gap-1 ml-4">
								<button
									class="text-muted-foreground hover:text-foreground p-1 rounded-sm hover:bg-muted transition-colors"
									title="Edit task"
									on:click|stopPropagation={() => openEditTaskModal(task)}
								>
									<Pencil size={16} />
								</button>
								<button
									class="text-muted-foreground hover:text-destructive p-1 rounded-sm hover:bg-muted transition-colors"
									title="Delete task"
									on:click|stopPropagation={() => deleteTask(task.id, featureId || '')}
								>
									<Trash2 size={16} />
								</button>
							</div>
						</div>
						{#if task.children && task.children.length > 0}
							<div class="ml-10 pl-4 py-2 border-l border-border divide-y divide-border">
								{#each task.children as childTask (childTask.id)}
									{@const childTaskIndexInFlatList = $tasks.findIndex(t => t.id === childTask.id)}
									{@const isChildNextPending = childTaskIndexInFlatList === firstPendingTaskIndex}
									{@const isChildInProgress = childTask.status === TaskStatus.IN_PROGRESS}
									<div 
										transition:fade={{ duration: 200 }}
										class="task-row flex items-start space-x-4 pt-3 pr-4 mb-3 
											   {isChildNextPending ? 'bg-muted/30' : ''} 
											   {isChildInProgress ? 'in-progress-shine relative overflow-hidden' : ''}
											   {childTask.status === TaskStatus.COMPLETED ? 'opacity-60' : ''}"
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
													class={`font-medium cursor-pointer ${childTask.status === TaskStatus.COMPLETED ? 'line-through text-muted-foreground' : ''}`}
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
										<div class="flex gap-1 ml-4">
											<button
												class="text-muted-foreground hover:text-foreground p-1 rounded-sm hover:bg-muted transition-colors"
												title="Edit subtask"
												on:click|stopPropagation={() => openEditTaskModal(childTask)}
											>
												<Pencil size={16} />
											</button>
											<button
												class="text-muted-foreground hover:text-destructive p-1 rounded-sm hover:bg-muted transition-colors"
												title="Delete subtask"
												on:click|stopPropagation={() => deleteTask(childTask.id, featureId || '')}
											>
												<Trash2 size={16} />
											</button>
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
						{completedCount} of {totalActionableTasks} actionable tasks completed
					</span>
					<div class="flex gap-2">
						<Button variant="outline" size="sm" on:click={() => showTaskFormModal = true} disabled={!featureId}>
							Add Task
						</Button>
						<Button variant="outline" size="sm" on:click={refreshTasks} disabled={$loading}>
							{#if $loading}
								<Loader2 class="mr-2 h-4 w-4 animate-spin" />
							{/if}
							Refresh
						</Button>
					</div>
				</div>
			</CardFooter>
		</Card>
	{/if}

	{#if questionData}
		<QuestionModal
			open={showQuestionModal}
			questionId={questionData.questionId}
			question={questionData.question}
			options={questionData.options || []}
			allowsText={questionData.allowsText !== false}
			on:response={handleQuestionResponse}
			on:cancel={handleQuestionCancel}
		/>
	{/if}

	{#if featureId}
		<TaskFormModal
			open={showTaskFormModal}
			featureId={featureId}
			isEditing={isEditing}
			editTask={editingTask ? {
				id: editingTask.id,
				title: editingTask.title || '',
				effort: editingTask.effort || 'medium'
			} : {
				id: '',
				title: '',
				effort: 'medium'
			}}
			on:submit={handleTaskFormSubmit}
			on:cancel={() => showTaskFormModal = false}
		/>
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

