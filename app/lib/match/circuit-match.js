// Port of Code/CircuitMatch.py's CircuitMatch class — a full circuit match: a set of net
// matches (from NetMatch.js) that together place every component the schematic needs, plus any
// "add wire"/"cut trace" interventions required to complete an imperfect match.
export class CircuitMatch {
  constructor(circuitArr) {
    this.circuitArr = circuitArr;
    this.touchedTraces = [];
    this.nets = [];
    this.refs = [];
    this.componentMatches = [];
    this.touchedPads = { frontPads: [], backPads: [] };
    this.refDict = {};
    this.cmDict = {};
    this.interventionsNetArr = [];
    for (const net of circuitArr) this._absorbNet(net);
  }

  // Shared by the constructor and add_net — both walk one net's nodes + interventions into the
  // circuit's aggregate state identically in the original (add_net has one dead-code typo,
  // `touched_pads['back_pads']` instead of `'back pads'`, for the list-form intervention branch,
  // which never actually wrote anywhere readable — omitted here since it was a no-op).
  _absorbNet(net) {
    this.touchedTraces = this.touchedTraces.concat(net.traces);
    this.nets.push(net.net);

    for (const node of net.nodes) {
      const ref = node.node.split('-')[0];
      this.refs.push(ref);
      this.refDict[ref] = node.match;
      if (!this.componentMatches.includes(node.match)) {
        this.componentMatches.push(node.match);
        if (node.match.touchedTracesList) {
          this.touchedTraces = this.touchedTraces.concat(node.match.touchedTracesList);
          if (node.match.fb === 'front') this.touchedPads.frontPads = this.touchedPads.frontPads.concat(node.match.padList);
          else this.touchedPads.backPads = this.touchedPads.backPads.concat(node.match.padList);
        }
      }
    }

    if (net.interventions) {
      this.interventionsNetArr.push(net);
      const interventionsList = Array.isArray(net.interventions) ? net.interventions : [net.interventions];
      for (const intervention of interventionsList) {
        if (!intervention.addWire) continue;
        const addWire = intervention.addWire;

        if (Array.isArray(addWire)) {
          const [ref, pin] = addWire[0].split('-');
          const cm = this.refDict[ref];
          this.touchedTraces = this.touchedTraces.concat(cm.touchedTracesDict[pin]);
        } else if (addWire.cmpntMatch) {
          const [ref, pin] = addWire.missingNode.split('-');
          const cm = addWire.cmpntMatch;
          this.refs.push(ref);
          this.refDict[ref] = cm;
          this.touchedTraces = this.touchedTraces.concat(cm.touchedTracesDict[pin]);
          if (cm.fb === 'front') this.touchedPads.frontPads = this.touchedPads.frontPads.concat(cm.padList);
          else this.touchedPads.backPads = this.touchedPads.backPads.concat(cm.padList);
        }
      }
    }
  }

  // mirrors add_net
  addNet(netDict) {
    this._absorbNet(netDict);
  }

  // mirrors copy
  copy() {
    return new CircuitMatch([...this.circuitArr]);
  }

  // mirrors update
  update(circuitArr) {
    return new CircuitMatch(circuitArr);
  }

  // mirrors update_traces: recomputes every net's traces/interventions against a (possibly
  // just-modified, e.g. after a trace cut) pcbBoard, and appends an "add wire" intervention for
  // any node that turns out to no longer be connected to the rest of its net.
  updateTraces(circuitArr, pcbBoard) {
    const newCircuitArr = [];

    for (const net of circuitArr) {
      net.traces = [];
      const netConnectionsDict = {};
      const nodeDict = {};

      for (const node of net.nodes) {
        const [nRef, nPin] = node.node.split('-');
        node.match.updateTraces(pcbBoard);

        const nTraces = node.match.touchedTracesDict[nPin];
        for (const nTrace of nTraces) {
          if (!net.traces.includes(nTrace)) net.traces.push(nTrace);
          netConnectionsDict[nTrace] = netConnectionsDict[nTrace] ? [...netConnectionsDict[nTrace], node.node] : [node.node];
        }
        if (!(nRef in nodeDict)) nodeDict[nRef] = node.match;
      }

      if (net.interventions) {
        const interventionsList = Array.isArray(net.interventions) ? net.interventions : [net.interventions];
        for (const intervention of interventionsList) {
          if (!intervention.addWire) continue;
          const wireInfo = intervention.addWire;

          if (Array.isArray(wireInfo)) {
            for (const missingNode of wireInfo) {
              const [ref, pin] = missingNode.split('-');
              const matchedNode = net.nodes.find((n) => n.node.split('-')[0] === ref);
              if (!matchedNode) continue;

              const nTraces = matchedNode.match.touchedTracesDict[pin];
              for (const nTrace of nTraces) {
                if (!net.traces.includes(nTrace)) net.traces.push(nTrace);
                netConnectionsDict[nTrace] = netConnectionsDict[nTrace] ? [...netConnectionsDict[nTrace], missingNode] : [missingNode];
              }
              if (!(ref in nodeDict)) nodeDict[ref] = matchedNode.match;
            }
          } else if (wireInfo.cmpntMatch) {
            const missingNode = wireInfo.missingNode;
            const pin = missingNode.split('-')[1];
            const cmpntMatch = wireInfo.cmpntMatch;
            cmpntMatch.updateTraces(pcbBoard);

            const nTraces = cmpntMatch.touchedTracesDict[pin];
            for (const nTrace of nTraces) {
              if (!net.traces.includes(nTrace)) net.traces.push(nTrace);
              netConnectionsDict[nTrace] = netConnectionsDict[nTrace] ? [...netConnectionsDict[nTrace], missingNode] : [missingNode];
            }
            if (!(missingNode.split('-')[0] in nodeDict)) nodeDict[missingNode.split('-')[0]] = cmpntMatch;
          }
        }
      }

      // is the net still fully connected after the trace update? if some nodes ended up
      // isolated on their own trace(s), flag them with an "add wire" intervention.
      const traceKeys = Object.keys(netConnectionsDict);
      if (traceKeys.length > 1) {
        const connectedNodesChecked = [];
        let unconnectedNodes = [];
        let firstTrace = true;

        for (const [, connectedNodes] of Object.entries(netConnectionsDict)) {
          if (firstTrace) {
            firstTrace = false;
            connectedNodesChecked.push(...connectedNodes);
            continue;
          }
          const connectionMade = connectedNodes.some((n) => connectedNodesChecked.includes(n));
          if (connectionMade) {
            for (const n of connectedNodes) if (!connectedNodesChecked.includes(n)) connectedNodesChecked.push(n);
          } else {
            unconnectedNodes = unconnectedNodes.concat(connectedNodes);
          }
        }

        unconnectedNodes = unconnectedNodes.filter((n) => !connectedNodesChecked.includes(n));

        for (const unconnectedNode of unconnectedNodes) {
          const cmpntMatch = nodeDict[unconnectedNode.split('-')[0]];
          const wireIntervention = { addWire: { missingNode: unconnectedNode, cmpntMatch } };

          if (net.interventions) {
            const list = Array.isArray(net.interventions) ? net.interventions : [net.interventions];
            const alreadyPresent = list.some((iv) => iv.addWire && !Array.isArray(iv.addWire) && iv.addWire.missingNode === unconnectedNode);
            if (!alreadyPresent) net.interventions = [...list, wireIntervention];
          } else {
            net.interventions = [wireIntervention];
          }
        }
      }

      newCircuitArr.push(net);
    }

    return new CircuitMatch(newCircuitArr);
  }

  // mirrors get_interventions_count
  getInterventionsCount() {
    let total = 0;
    for (const net of this.interventionsNetArr) {
      const list = Array.isArray(net.interventions) ? net.interventions : [net.interventions];
      for (const intervention of list) {
        if (intervention.addWire) total += 1;
        else if (intervention.traceCuts) total += intervention.traceCuts.frontCuts.length + intervention.traceCuts.backCuts.length;
      }
    }
    return total;
  }

  // mirrors get_all_trace_cuts
  getAllTraceCuts() {
    const traceCuts = { frontCuts: [], backCuts: [] };
    for (const net of this.interventionsNetArr) {
      const list = Array.isArray(net.interventions) ? net.interventions : [net.interventions];
      for (const intervention of list) {
        if (intervention.traceCuts) {
          traceCuts.frontCuts = traceCuts.frontCuts.concat(intervention.traceCuts.frontCuts);
          traceCuts.backCuts = traceCuts.backCuts.concat(intervention.traceCuts.backCuts);
        }
      }
    }
    return traceCuts.frontCuts.length + traceCuts.backCuts.length > 0 ? traceCuts : null;
  }
}
