# 🔧 Intentos de Soluciones - AgroCoop dApp

## 📋 **Problema Principal**
- **Error:** `txMalformed` con valor `-16` al crear pools
- **Síntoma:** La transacción se construye y firma correctamente, pero falla al enviar
- **Contexto:** Stellar SDK v12.1.0, Soroban smart contracts, Freighter wallet

---

## 🚫 **Intentos Fallidos**

### **Intento 1: Cambio de `invokeContractFunction` a `invokeHostFunction`**
- **Fecha:** 28/09/2025
- **Cambio:** Reemplazar `StellarSdk.Operation.invokeContractFunction` por `invokeHostFunction`
- **Sintaxis usada:**
  ```javascript
  StellarSdk.Operation.invokeHostFunction({
      func: StellarSdk.xdr.HostFunction.hostFunctionTypeInvokeContract(
          StellarSdk.xdr.InvokeContractArgs({
              contractAddress: StellarSdk.Address.contract(CONFIG.contractId).toScAddress(),
              functionName: 'create_pool',
              args: [creatorScVal, tokenScVal, supplierScVal, goalScVal, deadlineScVal]
          })
      )
  })
  ```
- **Resultado:** ❌ Error `Unsupported address type`
- **Causa:** `toScAddress()` no existe en SDK v12

### **Intento 2: Uso de `nativeToScVal()` para contractAddress**
- **Fecha:** 28/09/2025
- **Cambio:** Reemplazar `toScAddress()` por `nativeToScVal()`
- **Sintaxis usada:**
  ```javascript
  contractAddress: StellarSdk.nativeToScVal(StellarSdk.Address.contract(CONFIG.contractId), { type: 'address' })
  ```
- **Resultado:** ❌ Error `Unsupported address type`
- **Causa:** La estructura XDR `InvokeContractArgs` no acepta este formato

### **Intento 3: Eliminación de `toScAddress()`**
- **Fecha:** 28/09/2025
- **Cambio:** Usar `StellarSdk.Address.contract(CONFIG.contractId)` directamente
- **Sintaxis usada:**
  ```javascript
  contractAddress: StellarSdk.Address.contract(CONFIG.contractId)
  ```
- **Resultado:** ❌ Error `Unsupported address type`
- **Causa:** El tipo `Address` no es compatible con `contractAddress` en XDR

### **Intento 4: Restauración y cambio mínimo**
- **Fecha:** 28/09/2025
- **Cambio:** Solo cambiar `invokeContractFunction` por `invokeHostFunction` con sintaxis XDR
- **Resultado:** ❌ Error `Unsupported address type`
- **Causa:** El problema persiste en la estructura XDR

### **Intento 5: Uso de `toScAddress()` en `invokeHostFunction`**
- **Fecha:** 28/09/2025
- **Cambio:** Usar `invokeHostFunction` con `StellarSdk.Address.contract(CONFIG.contractId).toScAddress()`
- **Sintaxis usada:**
  ```javascript
  StellarSdk.Operation.invokeHostFunction({
      func: StellarSdk.xdr.HostFunction.hostFunctionTypeInvokeContract(
          StellarSdk.xdr.InvokeContractArgs({
              contractAddress: StellarSdk.Address.contract(CONFIG.contractId).toScAddress(),
              functionName: 'create_pool',
              args: [creatorScVal, tokenScVal, supplierScVal, goalScVal, deadlineScVal]
          })
      )
  })
  ```
- **Resultado:** ❌ Error `Unsupported address type`
- **Causa:** `toScAddress()` no existe en SDK v12 o la estructura XDR es incorrecta

### **Intento 6: Análisis crítico y soluciones basadas en el contrato**
- **Fecha:** 28/09/2025
- **Problema identificado:** El contrato requiere inicialización y los tipos de argumentos deben coincidir exactamente.
- **Cambios implementados:**
  1. **Verificación de inicialización:** Nueva función `isContractInitialized()` que verifica si el contrato está inicializado antes de crear pools.
  2. **Mejor logging:** Añadido logging detallado de tipos de argumentos y respuestas de transacciones.
  3. **Manejo de errores mejorado:** Análisis específico de tipos de error (`txMalformed`, `txFailed`).
  4. **Validación previa:** La función `createPool` ahora verifica la inicialización antes de proceder.
- **Sintaxis usada:**
  ```javascript
  // Verificación de inicialización
  const isInitialized = await isContractInitialized();
  if (!isInitialized) {
      showAlert('❌ El contrato no está inicializado. Haz clic en "Inicializar Contrato" primero.', 'danger');
      return;
  }
  
  // Uso de invokeContractFunction (API correcta)
  StellarSdk.Operation.invokeContractFunction({
      contract: CONFIG.contractId,
      function: 'create_pool',
      args: [creatorScVal, tokenScVal, supplierScVal, goalScVal, deadlineScVal]
  })
  ```
- **Resultado:** ❌ **AÚN FALLABA**
- **Causa:** El problema principal no era la inicialización, sino el flujo incorrecto de Soroban.

### **Intento 7: Corrección completa del flujo Soroban (simulate → prepare → sign → send)**
- **Fecha:** 28/09/2025
- **Problema identificado:** No se seguía el flujo correcto de Soroban y se usaba la propiedad incorrecta de Freighter.
- **Cambios implementados:**
  1. **Flujo Soroban correcto:** Implementado simulate → prepare → sign → send en todas las funciones.
  2. **Corrección de Freighter:** Cambiado `signedTxXdr` por `signedXDR` en todas las funciones.
  3. **Approve completo:** Añadido `expiration_ledger` al approve del token.
  4. **Decodificación ScVal:** Implementado `scValToNative` para decodificar respuestas del contrato.
  5. **Eliminación de función inexistente:** Reemplazado `get_pool_count` por `get_pool` en verificaciones.
- **Sintaxis usada:**
  ```javascript
  // Flujo Soroban correcto
  // 1) Construir operación
  const operation = StellarSdk.Operation.invokeContractFunction({...});
  
  // 2) Armar transacción base
  let transaction = new StellarSdk.TransactionBuilder(account, {...}).build();
  
  // 3) Simular y preparar (footprint + resource fee + auth)
  const simulation = await server.simulateTransaction(transaction);
  transaction = await server.prepareTransaction(transaction);
  
  // 4) Firmar y enviar (usando signedXDR)
  const signedTransaction = await window.freighter.signTransaction(transaction.toXDR(), {
      networkPassphrase: CONFIG.networkPassphrase,
      accountToSign: userAddress
  });
  const transactionToSubmit = StellarSdk.TransactionBuilder.fromXDR(
      signedTransaction.signedXDR, // ← CORREGIDO: signedXDR, no signedTxXdr
      CONFIG.networkPassphrase
  );
  ```
- **Resultado:** 🔄 **EN PRUEBA**
- **Hipótesis:** El problema principal era la falta del flujo simulate → prepare y el uso de la propiedad incorrecta de Freighter.

---

## 🔍 **Análisis de Errores**

### **Error `txMalformed` (-16)**
- **Significado:** La transacción está mal formada
- **Ubicación:** Al enviar la transacción al servidor
- **Causa probable:** Estructura XDR incorrecta o método no compatible

### **Error `Unsupported address type`**
- **Significado:** El tipo de dirección no es compatible
- **Ubicación:** Al construir `InvokeContractArgs`
- **Causa probable:** `StellarSdk.Address.contract()` no es el tipo correcto para `contractAddress`

---

## 🎯 **Próximos Intentos Sugeridos**

### **Intento 5: Usar API de alto nivel de Soroban**
- **Enfoque:** Usar `StellarSdk.SorobanRpc` en lugar de XDR directo
- **Ventaja:** API más estable y menos propensa a errores
- **Implementación:** Pendiente

### **Intento 6: Verificar versión del SDK**
- **Enfoque:** Actualizar a SDK v13+ o usar sintaxis específica de v12
- **Ventaja:** Versión más reciente con mejor soporte para Soroban
- **Implementación:** Pendiente

### **Intento 7: Usar sintaxis simplificada**
- **Enfoque:** Usar `StellarSdk.Operation.invokeHostFunction` con sintaxis más simple
- **Ventaja:** Menos propenso a errores de XDR
- **Implementación:** Pendiente

### **Intento 8: Verificar documentación oficial**
- **Enfoque:** Revisar ejemplos oficiales de Stellar SDK v12
- **Ventaja:** Sintaxis probada y funcional
- **Implementación:** Pendiente

---

## 📚 **Recursos Consultados**

- [Stellar SDK v12 Documentation](https://stellar.github.io/js-stellar-sdk/)
- [Soroban Smart Contracts Guide](https://soroban.stellar.org/)
- [Freighter Wallet API](https://github.com/stellar/freighter)

---

## 🏷️ **Tags**
- `txMalformed` `Unsupported address type` `Stellar SDK v12` `Soroban` `XDR` `invokeHostFunction` `InvokeContractArgs`

---

## 📝 **Notas Adicionales**

- El error persiste independientemente del método usado para `contractAddress`
- La transacción se construye y firma correctamente, el problema está en el envío
- Freighter funciona correctamente, el problema está en la estructura de la transacción
- El contrato es accesible (verificación con `get_pool_count` funciona)

---

**Última actualización:** 28/09/2025 - 20:25
