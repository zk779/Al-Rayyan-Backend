import express from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import { adminUserIds, beamsToken, pushEnabled } from "../utils/notifications.js";

// ADMIN ONLY. The notifications behind the header bell. Each admin has their own read / dismissed
// state (a removed notification disappears from THEIR list; it is deleted from the database once every admin has removed it).
//
//   GET    /api/notifications?limit=50   my list (newest first) + my unread count
//   PUT    /api/notifications/read-all   mark everything read
//   PUT    /api/notifications/:id/read   mark one read
//   DELETE /api/notifications/:id        remove one from my list
//   DELETE /api/notifications            remove them all from my list
//   GET    /api/notifications/config     { pushEnabled, instanceId }  (the instance id is public)
//   GET    /api/notifications/beams-auth?user_id=   Pusher Beams token for the logged-in admin

const router = express.Router();
const prisma = new PrismaClient();

async function authenticate(req, res, next) {
	const authHeader = req.headers.authorization;
	if (!authHeader) return res.status(401).json({ error: "Missing Authorization header" });
	const token = authHeader.split(" ")[1];
	try {
		const decoded = jwt.verify(token, process.env.JWT_SECRET);
		const user = await prisma.user.findUnique({ where: { id: decoded.id }, include: { role: true } });
		if (!user || !user.isActive) return res.status(401).json({ error: "User inactive or removed" });
		req.user = { ...decoded, roleName: user.role?.name || null };
		next();
	} catch {
		return res.status(401).json({ error: "Invalid or expired token" });
	}
}

const adminOnly = (req, res, next) => {
	if (String(req.user?.roleName || "").toUpperCase() !== "ADMIN") {
		return res.status(403).json({ success: false, error: "Only an admin can see notifications" });
	}
	next();
};

// Prisma + MongoDB doesn't store an empty list, so "not dismissed / not read by me" can't be asked of
// the database — the most recent notifications are loaded and sorted out here (an admin team is small).
const WINDOW = 500;
const recent = () => prisma.notification.findMany({ orderBy: { createdAt: "desc" }, take: WINDOW });
const visible = (rows, me) => rows.filter((n) => !(n.dismissedBy || []).includes(me));
const unreadOf = (rows, me) => rows.filter((n) => !(n.readBy || []).includes(me));
// A notification is really deleted once EVERY active admin has removed / cleared it.
async function purgeDismissed(ids) {
	if (!ids.length) return;
	const admins = await adminUserIds();
	if (!admins.length) return;
	const rows = await prisma.notification.findMany({ where: { id: { in: ids } }, select: { id: true, dismissedBy: true } });
	const gone = rows.filter((n) => admins.every((a) => (n.dismissedBy || []).includes(a))).map((n) => n.id);
	if (gone.length) await prisma.notification.deleteMany({ where: { id: { in: gone } } });
}
const pushMe = (ids, field, me) => (ids.length ? prisma.notification.updateMany({ where: { id: { in: ids } }, data: { [field]: { push: me } } }) : null);

router.get("/config", authenticate, adminOnly, (req, res) => {
	res.json({ success: true, data: { pushEnabled: pushEnabled(), instanceId: pushEnabled() ? process.env.BEAMS_INSTANCE_ID : null } });
});

// Pusher Beams asks this to prove which user a device belongs to — only for yourself
router.get("/beams-auth", authenticate, adminOnly, (req, res) => {
	if (!pushEnabled()) return res.status(503).json({ success: false, error: "Push notifications are not set up" });
	if (String(req.query.user_id) !== String(req.user.id)) return res.status(403).json({ success: false, error: "Not your user id" });
	res.json(beamsToken(req.user.id));
});

router.get("/", authenticate, adminOnly, async (req, res) => {
	try {
		const me = req.user.id;
		const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
		const mineRows = visible(await recent(), me);
		res.json({
			success: true,
			unread: unreadOf(mineRows, me).length,
			data: mineRows.slice(0, limit).map(({ readBy, dismissedBy, ...n }) => ({ ...n, read: (readBy || []).includes(me) })),
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({ success: false, error: "Failed to load notifications" });
	}
});

router.put("/read-all", authenticate, adminOnly, async (req, res) => {
	try {
		const me = req.user.id;
		await pushMe(unreadOf(visible(await recent(), me), me).map((n) => n.id), "readBy", me);
		res.json({ success: true });
	} catch (err) {
		console.error(err);
		res.status(500).json({ success: false, error: "Failed to mark them read" });
	}
});

router.put("/:id/read", authenticate, adminOnly, async (req, res) => {
	try {
		const me = req.user.id;
		const n = await prisma.notification.findUnique({ where: { id: req.params.id } });
		if (n && !(n.readBy || []).includes(me)) await pushMe([n.id], "readBy", me);
		res.json({ success: true });
	} catch (err) {
		res.status(400).json({ success: false, error: "Failed to mark it read" });
	}
});

router.delete("/:id", authenticate, adminOnly, async (req, res) => {
	try {
		const me = req.user.id;
		const n = await prisma.notification.findUnique({ where: { id: req.params.id } });
		if (n && !(n.dismissedBy || []).includes(me)) {
			await pushMe([n.id], "dismissedBy", me);
			if (!(n.readBy || []).includes(me)) await pushMe([n.id], "readBy", me);
			await purgeDismissed([n.id]);
		}
		res.json({ success: true });
	} catch (err) {
		res.status(400).json({ success: false, error: "Failed to remove it" });
	}
});

router.delete("/", authenticate, adminOnly, async (req, res) => {
	try {
		const me = req.user.id;
		const rows = visible(await recent(), me);
		await pushMe(rows.map((n) => n.id), "dismissedBy", me);
		await pushMe(unreadOf(rows, me).map((n) => n.id), "readBy", me);
		await purgeDismissed(rows.map((n) => n.id));
		res.json({ success: true });
	} catch (err) {
		console.error(err);
		res.status(500).json({ success: false, error: "Failed to clear them" });
	}
});

export default router;
