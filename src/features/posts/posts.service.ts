export async function startPostProcessWorkflow(
  context: DbContext,
  data: StartPostProcessInput,
) {
  let publishedAtISO: string | undefined;

  // Check if we need to auto-set/fix the published date
  if (data.status === "published") {
    const post = await PostRepo.findPostById(context.db, data.id);

    if (post && !post.publishedAt) {
      // Publish now if publishedAt is empty
      const now = new Date();
      await PostRepo.updatePost(context.db, post.id, { publishedAt: now });
      publishedAtISO = now.toISOString();
    } else if (post?.publishedAt) {
      const now = new Date();
      publishedAtISO = post.publishedAt.toISOString();

      // Fix timezone-induced "future" timestamps for same-day publishes.
      // If it's NOT a future post by date (e.g. same-day UTC noon),
      // but the timestamp is still in the future, treat it as "publish now"
      // so it shows immediately on the public site.
      const isFutureByDate = isFuturePublishDate(publishedAtISO, data.clientToday);
      if (!isFutureByDate && post.publishedAt.getTime() > now.getTime()) {
        await PostRepo.updatePost(context.db, post.id, { publishedAt: now });
        publishedAtISO = now.toISOString();
      }
    }
  }

  const isFuture =
    !!publishedAtISO && isFuturePublishDate(publishedAtISO, data.clientToday);

  await context.env.POST_PROCESS_WORKFLOW.create({
    params: {
      postId: data.id,
      isPublished: data.status === "published",
      publishedAt: publishedAtISO,
      isFuturePost: isFuture,
    },
  });

  // Defensively terminate any existing scheduled publish workflow for this post
  const scheduledId = `post-${data.id}-scheduled`;
  try {
    const oldInstance =
      await context.env.SCHEDULED_PUBLISH_WORKFLOW.get(scheduledId);
    await oldInstance.terminate();
  } catch {
    // Instance doesn't exist or already completed, ignore
  }

  // If this is a future post, create a new scheduled publish workflow
  if (data.status === "published" && isFuture) {
    await context.env.SCHEDULED_PUBLISH_WORKFLOW.create({
      id: scheduledId,
      params: { postId: data.id, publishedAt: publishedAtISO! },
    });
  }
}
