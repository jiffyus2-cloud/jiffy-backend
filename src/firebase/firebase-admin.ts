import * as admin from 'firebase-admin';

/**
 * Inicialización centralizada de Firebase Admin.
 *
 * Antes esto vivía en el constructor de StripeService y, si faltaban las
 * credenciales, solo escribía un aviso por consola y dejaba arrancar el
 * servidor. El resultado era el peor de los dos mundos: el servicio parecía
 * sano, pero `FirebaseAuthGuard` rechazaba todos los checkouts con un 401
 * imposible de diagnosticar desde fuera.
 *
 * Ahora la inicialización falla en el arranque: preferimos que el despliegue
 * se caiga a que se quede sirviendo pagos a medias.
 */

let initialized = false;

function buildCredential(): admin.credential.Credential {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || process.env.VITE_FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY || process.env.VITE_FIREBASE_PRIVATE_KEY;

  if (projectId && clientEmail && privateKey) {
    console.log('[firebase] Usando credenciales explícitas (FIREBASE_*).');
    return admin.credential.cert({
      projectId,
      clientEmail,
      // Las variables de entorno multilinea llegan con los saltos escapados.
      privateKey: privateKey.replace(/\\n/g, '\n'),
    });
  }

  // En Cloud Run la cuenta de servicio adjunta al servicio ya provee
  // Application Default Credentials, así que no hace falta configurar nada.
  console.log('[firebase] Sin credenciales explícitas; usando Application Default Credentials.');
  return admin.credential.applicationDefault();
}

/**
 * Inicializa Firebase Admin y comprueba que las credenciales sirven de verdad.
 * Lanza si no es posible: el llamante debe abortar el arranque.
 */
export async function initFirebaseAdmin(): Promise<void> {
  if (initialized || admin.apps.length > 0) {
    initialized = true;
    return;
  }

  let credential: admin.credential.Credential;
  try {
    credential = buildCredential();
  } catch (error: any) {
    throw new Error(
      `No se pudieron construir las credenciales de Firebase: ${error?.message ?? error}`
    );
  }

  admin.initializeApp({ credential });

  // `initializeApp` no valida nada por sí solo. Pedimos un token de acceso para
  // que un despliegue mal configurado falle aquí y no en el primer pago.
  try {
    await credential.getAccessToken();
  } catch (error: any) {
    throw new Error(
      'Firebase Admin no pudo autenticarse. Define FIREBASE_PROJECT_ID, ' +
      'FIREBASE_CLIENT_EMAIL y FIREBASE_PRIVATE_KEY, o despliega con una cuenta ' +
      `de servicio adjunta. Detalle: ${error?.message ?? error}`
    );
  }

  initialized = true;
  console.log('[firebase] Firebase Admin inicializado y verificado.');
}

export function getFirestore(): admin.firestore.Firestore {
  if (!initialized && admin.apps.length === 0) {
    throw new Error('Firebase Admin no está inicializado. Llama a initFirebaseAdmin() primero.');
  }
  return admin.firestore();
}
