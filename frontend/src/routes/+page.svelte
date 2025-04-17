<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import type { Task } from '$lib/types';
	import { TaskStatus, TaskEffort } from '$lib/types';

	let tasks: Task[] = [];
	let loading = true;
	let error = '';
	let featureId: string | null = null;
	let features: string[] = [];
	let loadingFeatures = true;

	// Function to fetch tasks, optionally for a specific feature
	async function fetchTasks(featureId?: string) {
		loading = true;
		error = '';
		
		try {
			// Construct the API endpoint based on whether we have a featureId
			const endpoint = featureId 
				? `/api/tasks/${featureId}` 
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
					feature_id: task.feature_id || featureId || undefined,
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

	// Fetch the list of available features
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
		
		// Then fetch tasks (either for specific feature or default)
		await fetchTasks(featureId || undefined);
	});

	function toggleTaskStatus(taskId: string) {
		tasks = tasks.map(task => {
			if (task.id === taskId) {
				const completed = !task.completed;
				return { 
					...task, 
					completed,
					status: completed ? TaskStatus.COMPLETED : TaskStatus.IN_PROGRESS
				};
			}
			return task;
		});
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

	function refreshTasks() {
		fetchTasks(featureId || undefined);
	}

	function switchFeature(newFeatureId: string) {
		featureId = newFeatureId;
		// Update URL without refreshing the page
		const url = new URL(window.location.href);
		url.searchParams.set('featureId', newFeatureId);
		window.history.pushState({}, '', url);
		
		// Fetch tasks for the new feature
		fetchTasks(newFeatureId);
	}
</script>

<div class="container mx-auto py-8 px-4 max-w-4xl">
	<h1 class="text-3xl font-bold mb-6">Task Manager</h1>

	{#if loading}
		<div class="flex justify-center my-8">
			<div class="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary"></div>
		</div>
	{:else if error}
		<Card class="mb-6">
			<CardHeader>
				<CardTitle class="text-destructive">Error</CardTitle>
				<CardDescription>{error}</CardDescription>
			</CardHeader>
			<CardContent>
				{#if features.length > 0}
					<p class="text-sm">Try selecting a different feature or refreshing the page.</p>
				{:else}
					<p class="text-sm">No features found. Create a feature using the task manager CLI.</p>
				{/if}
			</CardContent>
		</Card>
	{/if}

	{#if features.length > 0}
		<div class="mb-4">
			<label for="feature-select" class="block text-sm font-medium mb-2">Select Feature</label>
			<select 
				id="feature-select" 
				class="w-full p-2 border rounded-md"
				disabled={loadingFeatures}
				value={featureId || ''}
				on:change={(e) => switchFeature(e.currentTarget.value)}
			>
				{#if !featureId}
					<option value="">Default (Most Recent)</option>
				{/if}
				{#each features as feature}
					<option value={feature}>{feature}</option>
				{/each}
			</select>
		</div>
	{/if}

	<Card>
		<CardHeader>
			<CardTitle class="flex justify-between items-center">
				<span>Tasks</span>
				<Badge variant="outline" class="ml-2">{tasks.length}</Badge>
			</CardTitle>
			<CardDescription>
				Manage your tasks and track progress
			</CardDescription>
		</CardHeader>
		<CardContent>
			<div class="space-y-4">
				{#each tasks as task (task.id)}
					<div class="flex items-start space-x-4 p-3 rounded-md hover:bg-muted/50 transition-colors border-b">
						<Checkbox checked={task.completed} onCheckedChange={() => toggleTaskStatus(task.id)} />
						<div class="flex-1">
							<p class={task.completed ? 'line-through text-muted-foreground font-medium' : 'font-medium'}>
								{task.title}
							</p>
							{#if task.description}
								<p class="text-sm text-muted-foreground mt-1">
									{task.description}
								</p>
							{/if}
						</div>
						<div class="flex flex-col gap-2 items-end">
							<Badge variant={getStatusBadgeVariant(task.status)}>
								{task.status.replace('_', ' ')}
							</Badge>
							{#if task.effort}
								<Badge variant={getEffortBadgeVariant(task.effort)}>
									{task.effort}
								</Badge>
							{/if}
						</div>
					</div>
				{:else}
					<div class="text-center py-4 text-muted-foreground">
						No tasks found
					</div>
				{/each}
			</div>
		</CardContent>
		<CardFooter class="flex justify-between">
			<span class="text-sm text-muted-foreground">
				{tasks.filter(t => t.completed).length} of {tasks.length} tasks completed
			</span>
			<Button variant="outline" size="sm" on:click={refreshTasks}>
				Refresh
			</Button>
		</CardFooter>
	</Card>
</div>

<style>
	/* Additional styles can be added here if needed */
</style>
