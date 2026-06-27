const { db, admin } = require('../firebaseAdmin');
const { FINANCE_SCOPES } = require('../mcp/profiles/finance/scopes');
const AppError = require('../utils/AppError');

const FINANCE_WORKSPACES_COLLECTION = 'financeWorkspaces';
const FINANCE_PROFILE_ID = 'finance';

const cleanData = (data) => Object.fromEntries(
  Object.entries(data).filter(([, value]) => value !== undefined)
);

const getFinanceProfile = (userData = {}) => {
  const profile = userData.profiles?.[FINANCE_PROFILE_ID];
  return profile && typeof profile === 'object' ? profile : {};
};

const getFinanceWorkspaceState = (userData = {}) => {
  const profile = getFinanceProfile(userData);

  return {
    defaultWorkspaceId: profile.defaultWorkspaceId || '',
    workspaceIds: Array.isArray(profile.workspaceIds) ? profile.workspaceIds : []
  };
};

const withId = (snapshot) => {
  if (!snapshot.exists) {
    return null;
  }

  return {
    id: snapshot.id,
    ...snapshot.data()
  };
};

const getDateValue = (value) => {
  if (!value) {
    return null;
  }

  if (typeof value.toDate === 'function') {
    return value.toDate();
  }

  return new Date(value);
};

const mapDocument = (snapshot) => {
  const data = withId(snapshot);

  if (!data) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => {
      const date = getDateValue(value);
      return date && key.endsWith('At') ? [key, date.toISOString()] : [key, value];
    })
  );
};

class FinanceRepository {
  async ensurePersonalWorkspaceForUser({ userId, displayName = '', currency = 'MXN' }) {
    const userRef = db.collection('users').doc(userId);
    const userSnapshot = await userRef.get();
    const userData = userSnapshot.exists ? userSnapshot.data() : {};
    const { defaultWorkspaceId, workspaceIds } = getFinanceWorkspaceState(userData);

    if (workspaceIds.length) {
      return {
        workspaceId: defaultWorkspaceId || workspaceIds[0],
        created: false
      };
    }

    const result = await this.createWorkspace({
      userId,
      payload: {
        name: displayName ? `${displayName} Personal` : 'Personal',
        type: 'personal',
        currency,
        description: 'Personal finance workspace.'
      },
      makeDefault: true
    });

    return {
      workspaceId: result.workspaceId,
      created: true
    };
  }

  async createWorkspace({ userId, payload, makeDefault = false }) {
    const workspaceRef = db.collection(FINANCE_WORKSPACES_COLLECTION).doc();
    const userRef = db.collection('users').doc(userId);
    const memberRef = workspaceRef.collection('members').doc(userId);

    await db.runTransaction(async (transaction) => {
      const userSnapshot = await transaction.get(userRef);
      const userData = userSnapshot.exists ? userSnapshot.data() : {};
      const now = admin.firestore.FieldValue.serverTimestamp();
      const { defaultWorkspaceId, workspaceIds } = getFinanceWorkspaceState(userData);
      const shouldSetDefault = makeDefault || !defaultWorkspaceId || !workspaceIds.length;

      transaction.set(workspaceRef, cleanData({
        name: payload.name,
        normalizedName: payload.normalizedName,
        type: payload.type,
        currency: payload.currency,
        description: payload.description || '',
        ownerUserId: userId,
        memberIds: [userId],
        active: true,
        createdAt: now,
        updatedAt: now
      }));

      transaction.set(memberRef, {
        userId,
        role: 'owner',
        status: 'active',
        grantedScopes: FINANCE_SCOPES,
        joinedAt: now,
        updatedAt: now
      });

      transaction.set(userRef, cleanData({
        profiles: {
          finance: cleanData({
            workspaceIds: admin.firestore.FieldValue.arrayUnion(workspaceRef.id),
            defaultWorkspaceId: shouldSetDefault ? workspaceRef.id : undefined
          })
        },
        updatedAt: now
      }), { merge: true });
    });

    return {
      workspaceId: workspaceRef.id
    };
  }

  async getUserWorkspaceIds(userId) {
    const userSnapshot = await db.collection('users').doc(userId).get();

    if (!userSnapshot.exists) {
      return {
        defaultWorkspaceId: '',
        workspaceIds: []
      };
    }

    const data = userSnapshot.data();
    const { defaultWorkspaceId, workspaceIds } = getFinanceWorkspaceState(data);

    return {
      defaultWorkspaceId,
      workspaceIds
    };
  }

  async listUserWorkspaces(userId) {
    const { defaultWorkspaceId, workspaceIds } = await this.getUserWorkspaceIds(userId);

    if (!workspaceIds.length) {
      return [];
    }

    const refs = workspaceIds.map((workspaceId) => db.collection(FINANCE_WORKSPACES_COLLECTION).doc(workspaceId));
    const snapshots = await db.getAll(...refs);

    return snapshots
      .map(mapDocument)
      .filter((workspace) => workspace && workspace.active !== false)
      .map((workspace) => ({
        ...workspace,
        workspaceId: workspace.id,
        isDefault: workspace.id === defaultWorkspaceId
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async getWorkspace(workspaceId) {
    const snapshot = await db.collection(FINANCE_WORKSPACES_COLLECTION).doc(workspaceId).get();
    return mapDocument(snapshot);
  }

  async getWorkspaceMember({ workspaceId, userId }) {
    const snapshot = await db
      .collection(FINANCE_WORKSPACES_COLLECTION)
      .doc(workspaceId)
      .collection('members')
      .doc(userId)
      .get();

    return mapDocument(snapshot);
  }

  async getUserById(userId) {
    const snapshot = await db.collection('users').doc(userId).get();
    const user = mapDocument(snapshot);

    return user ? {
      ...user,
      userId: user.id
    } : null;
  }

  async findUserByEmail(email) {
    const normalizedEmail = String(email || '').trim().toLowerCase();

    if (!normalizedEmail) {
      return null;
    }

    const snapshot = await db
      .collection('users')
      .where('email', '==', normalizedEmail)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return null;
    }

    const user = mapDocument(snapshot.docs[0]);

    return {
      ...user,
      userId: user.id
    };
  }

  async listWorkspaceMembers({ workspaceId, includeInactive = false }) {
    const snapshot = await db
      .collection(FINANCE_WORKSPACES_COLLECTION)
      .doc(workspaceId)
      .collection('members')
      .get();

    const members = snapshot.docs
      .map(mapDocument)
      .map((member) => ({
        ...member,
        memberId: member.id,
        userId: member.userId || member.id
      }))
      .filter((member) => includeInactive || member.status !== 'inactive');

    if (!members.length) {
      return [];
    }

    const userRefs = members.map((member) => db.collection('users').doc(member.userId));
    const userSnapshots = await db.getAll(...userRefs);
    const usersById = new Map(
      userSnapshots
        .map(mapDocument)
        .filter(Boolean)
        .map((user) => [user.id, user])
    );

    return members
      .map((member) => {
        const user = usersById.get(member.userId) || {};

        return {
          ...member,
          email: member.email || user.email || '',
          displayName: member.displayName || user.displayName || '',
          photoURL: member.photoURL || user.photoURL || '',
          emailVerified: user.emailVerified || false
        };
      })
      .sort((left, right) => {
        if (left.role === 'owner' && right.role !== 'owner') {
          return -1;
        }

        if (left.role !== 'owner' && right.role === 'owner') {
          return 1;
        }

        return String(left.displayName || left.email || left.userId)
          .localeCompare(String(right.displayName || right.email || right.userId));
      });
  }

  async upsertWorkspaceMember({
    workspaceId,
    targetUser,
    role,
    grantedScopes,
    notes,
    addedByUserId
  }) {
    const workspaceRef = db.collection(FINANCE_WORKSPACES_COLLECTION).doc(workspaceId);
    const userRef = db.collection('users').doc(targetUser.userId);
    const memberRef = workspaceRef.collection('members').doc(targetUser.userId);
    let created = false;

    await db.runTransaction(async (transaction) => {
      const [workspaceSnapshot, userSnapshot, memberSnapshot] = await Promise.all([
        transaction.get(workspaceRef),
        transaction.get(userRef),
        transaction.get(memberRef)
      ]);

      if (!workspaceSnapshot.exists || workspaceSnapshot.get('active') === false) {
        throw new AppError({
          statusCode: 404,
          code: 'workspace_not_found',
          message: 'Workspace does not exist or is inactive.'
        });
      }

      if (!userSnapshot.exists) {
        throw new AppError({
          statusCode: 404,
          code: 'member_user_not_found',
          message: 'The member user does not exist.'
        });
      }

      const now = admin.firestore.FieldValue.serverTimestamp();
      const userData = userSnapshot.data() || {};
      const { defaultWorkspaceId, workspaceIds } = getFinanceWorkspaceState(userData);
      const shouldSetDefault = !defaultWorkspaceId && !workspaceIds.length;
      created = !memberSnapshot.exists;

      transaction.set(memberRef, cleanData({
        userId: targetUser.userId,
        email: targetUser.email || userData.email || '',
        displayName: targetUser.displayName || userData.displayName || '',
        photoURL: targetUser.photoURL || userData.photoURL || '',
        role,
        status: 'active',
        grantedScopes,
        notes,
        addedByUserId,
        joinedAt: created ? now : undefined,
        updatedAt: now
      }), { merge: true });

      transaction.set(workspaceRef, {
        memberIds: admin.firestore.FieldValue.arrayUnion(targetUser.userId),
        updatedAt: now
      }, { merge: true });

      transaction.set(userRef, cleanData({
        profiles: {
          finance: cleanData({
            workspaceIds: admin.firestore.FieldValue.arrayUnion(workspaceId),
            defaultWorkspaceId: shouldSetDefault ? workspaceId : undefined
          })
        },
        updatedAt: now
      }), { merge: true });
    });

    return {
      memberUserId: targetUser.userId,
      created
    };
  }

  async listCategories({ workspaceId, type = '', includeInactive = false }) {
    const snapshot = await db
      .collection(FINANCE_WORKSPACES_COLLECTION)
      .doc(workspaceId)
      .collection('categories')
      .orderBy('name')
      .get();

    return snapshot.docs
      .map(mapDocument)
      .filter((category) => category && (includeInactive || category.active !== false))
      .filter((category) => !type || category.type === type || category.type === 'both')
      .map((category) => ({
        ...category,
        categoryId: category.id
      }));
  }

  async getCategory({ workspaceId, categoryId }) {
    const snapshot = await db
      .collection(FINANCE_WORKSPACES_COLLECTION)
      .doc(workspaceId)
      .collection('categories')
      .doc(categoryId)
      .get();

    const category = mapDocument(snapshot);

    return category ? {
      ...category,
      categoryId: category.id
    } : null;
  }

  async findCategoriesByNormalizedName({ workspaceId, normalizedName }) {
    const snapshot = await db
      .collection(FINANCE_WORKSPACES_COLLECTION)
      .doc(workspaceId)
      .collection('categories')
      .where('normalizedName', '==', normalizedName)
      .limit(10)
      .get();

    return snapshot.docs
      .map(mapDocument)
      .filter((category) => category && category.active !== false)
      .map((category) => ({
        ...category,
        categoryId: category.id
      }));
  }

  async upsertCategory({ workspaceId, payload }) {
    const categoriesRef = db
      .collection(FINANCE_WORKSPACES_COLLECTION)
      .doc(workspaceId)
      .collection('categories');
    const now = admin.firestore.FieldValue.serverTimestamp();
    let categoryRef = payload.categoryId ? categoriesRef.doc(payload.categoryId) : null;
    let isNewCategory = !payload.categoryId;

    if (!categoryRef) {
      const existing = await categoriesRef
        .where('normalizedName', '==', payload.normalizedName)
        .limit(1)
        .get();

      categoryRef = existing.empty ? categoriesRef.doc() : existing.docs[0].ref;
      isNewCategory = existing.empty;
    }

    await categoryRef.set(cleanData({
      name: payload.name,
      normalizedName: payload.normalizedName,
      type: payload.type,
      description: payload.description,
      active: payload.active,
      updatedAt: now,
      createdAt: isNewCategory ? now : undefined
    }), { merge: true });

    return {
      categoryId: categoryRef.id
    };
  }

  async listAccounts(workspaceId) {
    const snapshot = await db
      .collection(FINANCE_WORKSPACES_COLLECTION)
      .doc(workspaceId)
      .collection('accounts')
      .orderBy('name')
      .get();

    return snapshot.docs
      .map(mapDocument)
      .filter((account) => account && account.active !== false)
      .map((account) => ({
        ...account,
        accountId: account.id
      }));
  }

  async getAccount({ workspaceId, accountId }) {
    const snapshot = await db
      .collection(FINANCE_WORKSPACES_COLLECTION)
      .doc(workspaceId)
      .collection('accounts')
      .doc(accountId)
      .get();

    const account = mapDocument(snapshot);

    return account ? {
      ...account,
      accountId: account.id
    } : null;
  }

  async findAccountsByNormalizedName({ workspaceId, normalizedName }) {
    const snapshot = await db
      .collection(FINANCE_WORKSPACES_COLLECTION)
      .doc(workspaceId)
      .collection('accounts')
      .where('normalizedName', '==', normalizedName)
      .limit(10)
      .get();

    return snapshot.docs
      .map(mapDocument)
      .filter((account) => account && account.active !== false)
      .map((account) => ({
        ...account,
        accountId: account.id
      }));
  }

  async upsertAccount({ workspaceId, payload }) {
    const accountsRef = db
      .collection(FINANCE_WORKSPACES_COLLECTION)
      .doc(workspaceId)
      .collection('accounts');
    const now = admin.firestore.FieldValue.serverTimestamp();
    let accountRef = payload.accountId ? accountsRef.doc(payload.accountId) : null;
    let isNewAccount = !payload.accountId;

    if (!accountRef) {
      const existing = await accountsRef
        .where('normalizedName', '==', payload.normalizedName)
        .limit(1)
        .get();

      accountRef = existing.empty ? accountsRef.doc() : existing.docs[0].ref;
      isNewAccount = existing.empty;
    }

    await accountRef.set(cleanData({
      name: payload.name,
      normalizedName: payload.normalizedName,
      type: payload.type,
      currency: payload.currency,
      balanceMinor: isNewAccount || payload.balanceWasProvided ? payload.balanceMinor : undefined,
      balance: isNewAccount || payload.balanceWasProvided ? payload.balance : undefined,
      initialBalanceMinor: isNewAccount ? payload.balanceMinor : undefined,
      initialBalance: isNewAccount ? payload.balance : undefined,
      institution: payload.institution,
      description: payload.description,
      active: payload.active,
      updatedAt: now,
      createdAt: isNewAccount ? now : undefined
    }), { merge: true });

    return {
      accountId: accountRef.id
    };
  }

  async listPaymentMethods({ workspaceId, accountId }) {
    const snapshot = await db
      .collection(FINANCE_WORKSPACES_COLLECTION)
      .doc(workspaceId)
      .collection('accounts')
      .doc(accountId)
      .collection('paymentMethods')
      .orderBy('name')
      .get();

    return snapshot.docs
      .map(mapDocument)
      .filter((method) => method && method.active !== false)
      .map((method) => ({
        ...method,
        paymentMethodId: method.id,
        accountId
      }));
  }

  async getPaymentMethod({ workspaceId, accountId, paymentMethodId }) {
    const snapshot = await db
      .collection(FINANCE_WORKSPACES_COLLECTION)
      .doc(workspaceId)
      .collection('accounts')
      .doc(accountId)
      .collection('paymentMethods')
      .doc(paymentMethodId)
      .get();

    const paymentMethod = mapDocument(snapshot);

    return paymentMethod ? {
      ...paymentMethod,
      paymentMethodId: paymentMethod.id,
      accountId
    } : null;
  }

  async findPaymentMethodsByNormalizedName({ workspaceId, accountId, normalizedName }) {
    const snapshot = await db
      .collection(FINANCE_WORKSPACES_COLLECTION)
      .doc(workspaceId)
      .collection('accounts')
      .doc(accountId)
      .collection('paymentMethods')
      .where('normalizedName', '==', normalizedName)
      .limit(10)
      .get();

    return snapshot.docs
      .map(mapDocument)
      .filter((method) => method && method.active !== false)
      .map((method) => ({
        ...method,
        paymentMethodId: method.id,
        accountId
      }));
  }

  async upsertPaymentMethod({ workspaceId, accountId, payload }) {
    const methodsRef = db
      .collection(FINANCE_WORKSPACES_COLLECTION)
      .doc(workspaceId)
      .collection('accounts')
      .doc(accountId)
      .collection('paymentMethods');
    const now = admin.firestore.FieldValue.serverTimestamp();
    let paymentMethodRef = payload.paymentMethodId ? methodsRef.doc(payload.paymentMethodId) : null;
    let isNewPaymentMethod = !payload.paymentMethodId;

    if (!paymentMethodRef) {
      const existing = await methodsRef
        .where('normalizedName', '==', payload.normalizedName)
        .limit(1)
        .get();

      paymentMethodRef = existing.empty ? methodsRef.doc() : existing.docs[0].ref;
      isNewPaymentMethod = existing.empty;
    }

    await paymentMethodRef.set(cleanData({
      name: payload.name,
      normalizedName: payload.normalizedName,
      type: payload.type,
      last4: payload.last4,
      network: payload.network,
      description: payload.description,
      active: payload.active,
      updatedAt: now,
      createdAt: isNewPaymentMethod ? now : undefined
    }), { merge: true });

    return {
      paymentMethodId: paymentMethodRef.id
    };
  }

  async createMovementWithIdempotency({
    workspaceId,
    userId,
    movement,
    accountDeltas,
    idempotencyKey,
    idempotencyHash,
    idempotencyScopeDate,
    action
  }) {
    const workspaceRef = db.collection(FINANCE_WORKSPACES_COLLECTION).doc(workspaceId);
    const idempotencyRef = workspaceRef.collection('idempotencyKeys').doc(idempotencyHash);
    const movementRef = workspaceRef.collection('movements').doc();
    const accountRefs = accountDeltas.map((delta) => workspaceRef.collection('accounts').doc(delta.accountId));

    return db.runTransaction(async (transaction) => {
      const idempotencySnapshot = await transaction.get(idempotencyRef);

      if (idempotencySnapshot.exists) {
        const idempotencyData = idempotencySnapshot.data();
        throw new AppError({
          statusCode: 409,
          code: 'duplicate_action',
          message: 'A movement with this idempotencyKey already exists.',
          details: {
            documentId: idempotencyData.documentId || null,
            idempotencyScopeDate: idempotencyData.idempotencyScopeDate || ''
          }
        });
      }

      const accountSnapshots = [];

      for (const accountRef of accountRefs) {
        accountSnapshots.push(await transaction.get(accountRef));
      }

      const now = admin.firestore.FieldValue.serverTimestamp();

      accountSnapshots.forEach((snapshot, index) => {
        const delta = accountDeltas[index];
        const data = snapshot.data();
        const currentBalanceMinor = Number(data?.balanceMinor || 0);
        const nextBalanceMinor = currentBalanceMinor + delta.deltaMinor;

        transaction.update(snapshot.ref, {
          balanceMinor: nextBalanceMinor,
          balance: Number((nextBalanceMinor / 100).toFixed(2)),
          updatedAt: now
        });
      });

      transaction.set(movementRef, {
        ...movement,
        idempotencyKey,
        idempotencyHash,
        createdBy: userId,
        createdAt: now,
        updatedAt: now
      });

      transaction.set(idempotencyRef, {
        action,
        documentId: movementRef.id,
        idempotencyKey,
        idempotencyScopeDate,
        createdBy: userId,
        createdAt: now
      });

      return {
        documentId: movementRef.id
      };
    });
  }

  async listMovements({ workspaceId, filters, cursor = null, limit }) {
    let query = db
      .collection(FINANCE_WORKSPACES_COLLECTION)
      .doc(workspaceId)
      .collection('movements')
      .where('date', '>=', filters.startDate)
      .where('date', '<=', filters.endDate)
      .orderBy('date', 'desc')
      .orderBy(admin.firestore.FieldPath.documentId(), 'desc');

    if (cursor?.date && cursor?.movementId) {
      query = query.startAfter(cursor.date, cursor.movementId);
    }

    const pageLimit = Number(limit || filters.limit || 50);
    const snapshot = await query
      .limit(pageLimit + 1)
      .get();
    const docs = snapshot.docs.slice(0, pageLimit);
    const hasMore = snapshot.docs.length > pageLimit;
    const lastDoc = docs[docs.length - 1];
    const movements = docs
      .map(mapDocument)
      .filter((movement) => movement && movement.active !== false)
      .map((movement) => ({
        ...movement,
        movementId: movement.id
      }));

    return {
      movements,
      pagination: {
        hasMore,
        nextCursor: lastDoc ? {
          date: lastDoc.get('date') || '',
          movementId: lastDoc.id
        } : null
      }
    };
  }

  async createActionLog(logData) {
    const logRef = db.collection('actionLogs').doc();
    await logRef.set({
      ...logData,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      id: logRef.id
    };
  }
}

module.exports = new FinanceRepository();
